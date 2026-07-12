package internal

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config for the provision HTTP API.
type Config struct {
	Token            string
	AuthorizedKeysDir string
	LedgerPath       string
	// MaxConcurrentKeys is a hard ceiling on non-expired keys (global).
	MaxConcurrentKeys int
	Logger           *log.Logger
}

// Server is the JIT SSH provision HTTP surface.
type Server struct {
	cfg    Config
	ledger *Ledger
	log    *log.Logger
	now    func() time.Time
}

func NewServer(cfg Config) *Server {
	lg := cfg.Logger
	if lg == nil {
		lg = log.Default()
	}
	maxK := cfg.MaxConcurrentKeys
	if maxK <= 0 {
		maxK = 256
	}
	cfg.MaxConcurrentKeys = maxK
	return &Server{
		cfg:    cfg,
		ledger: NewLedger(cfg.LedgerPath),
		log:    lg,
		now:    time.Now,
	}
}

type provisionRequest struct {
	PublicKey     string            `json:"publicKey"`
	ForcedCommand string            `json:"forcedCommand"`
	JobID         string            `json:"jobId"`
	SingleUse     bool              `json:"singleUse"`
	MaxSessions   int               `json:"maxSessions"`
	TTLSeconds    int               `json:"ttlSeconds"`
	Environment   map[string]string `json:"environment"`
}

type provisionResponse struct {
	OK        bool   `json:"ok"`
	KeyID     string `json:"keyId"`
	ExpiresAt string `json:"expiresAt"`
}

type revokeRequest struct {
	JobID string `json:"jobId"`
	KeyID string `json:"keyId"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/provision", s.handleProvision)
	mux.HandleFunc("POST /v1/revoke", s.handleRevoke)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.Token == "" {
		http.Error(w, `{"error":"server misconfigured: no token"}`, http.StatusInternalServerError)
		return false
	}
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	got := strings.TrimSpace(strings.TrimPrefix(h, prefix))
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) != 1 {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	return true
}

func (s *Server) handleProvision(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}
	var req provisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.PublicKey) == "" {
		http.Error(w, `{"error":"publicKey is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.JobID) == "" {
		http.Error(w, `{"error":"jobId is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.ForcedCommand) == "" {
		req.ForcedCommand = "commit-agent-once"
	}
	if req.TTLSeconds <= 0 || req.TTLSeconds > 3600 {
		http.Error(w, `{"error":"ttlSeconds must be 1..3600"}`, http.StatusBadRequest)
		return
	}
	if req.MaxSessions <= 0 {
		req.MaxSessions = 8
	}
	if req.SingleUse {
		req.MaxSessions = 1
	}
	if err := ValidateEd25519OpenSSH(req.PublicKey); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}

	now := s.now()
	active, err := s.ledger.Active(now)
	if err != nil {
		s.log.Printf("ledger active: %v", err)
		http.Error(w, `{"error":"ledger read failed"}`, http.StatusInternalServerError)
		return
	}
	if len(active) >= s.cfg.MaxConcurrentKeys {
		http.Error(w, `{"error":"max concurrent keys"}`, http.StatusConflict)
		return
	}
	// Per-job: count entries still usable (sessionsUsed < maxSessions)
	jobCount, err := s.ledger.CountActiveForJob(req.JobID, now)
	if err != nil {
		http.Error(w, `{"error":"ledger read failed"}`, http.StatusInternalServerError)
		return
	}
	if jobCount >= req.MaxSessions {
		http.Error(w, `{"error":"max concurrent keys for job"}`, http.StatusConflict)
		return
	}

	line, err := RenderAuthorizedKeysLine(req.ForcedCommand, req.PublicKey, req.Environment)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}

	keyID, err := randomKeyID()
	if err != nil {
		http.Error(w, `{"error":"key id generation failed"}`, http.StatusInternalServerError)
		return
	}
	expires := now.Add(time.Duration(req.TTLSeconds) * time.Second)
	fileName := fmt.Sprintf("pgos-%s-%s.pub", SafeFileComponent(req.JobID), SafeFileComponent(keyID))
	if err := os.MkdirAll(s.cfg.AuthorizedKeysDir, 0o700); err != nil {
		s.log.Printf("mkdir keys dir: %v", err)
		http.Error(w, `{"error":"write failure"}`, http.StatusInternalServerError)
		return
	}
	filePath := filepath.Join(s.cfg.AuthorizedKeysDir, fileName)
	if err := os.WriteFile(filePath, []byte(line+"\n"), 0o600); err != nil {
		s.log.Printf("write key file: %v", err)
		http.Error(w, `{"error":"write failure"}`, http.StatusInternalServerError)
		return
	}
	// Ensure mode 600 even on umask-heavy hosts
	_ = os.Chmod(filePath, 0o600)

	entry := LedgerEntry{
		KeyID:        keyID,
		JobID:        req.JobID,
		PublicKey:    req.PublicKey,
		FilePath:     filePath,
		ForcedCmd:    req.ForcedCommand,
		Environment:  req.Environment,
		SingleUse:    req.SingleUse,
		MaxSessions:  req.MaxSessions,
		SessionsUsed: 0,
		CreatedAt:    now,
		ExpiresAt:    expires,
	}
	if err := s.ledger.Add(entry); err != nil {
		_ = os.Remove(filePath)
		s.log.Printf("ledger add: %v", err)
		http.Error(w, `{"error":"write failure"}`, http.StatusInternalServerError)
		return
	}

	s.log.Printf("provisioned keyId=%s jobId=%s expiresAt=%s file=%s", keyID, req.JobID, expires.UTC().Format(time.RFC3339), fileName)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(provisionResponse{
		OK:        true,
		KeyID:     keyID,
		ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}
	var req revokeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.JobID == "" || req.KeyID == "" {
		http.Error(w, `{"error":"jobId and keyId required"}`, http.StatusBadRequest)
		return
	}
	removed, err := s.ledger.Remove(req.JobID, req.KeyID)
	if err != nil {
		http.Error(w, `{"error":"ledger write failed"}`, http.StatusInternalServerError)
		return
	}
	if removed != nil && removed.FilePath != "" {
		_ = os.Remove(removed.FilePath)
		s.log.Printf("revoked keyId=%s jobId=%s", req.KeyID, req.JobID)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// SweepOnce deletes expired key files and ledger rows. Returns number purged.
func (s *Server) SweepOnce() int {
	expired, err := s.ledger.PurgeExpired(s.now())
	if err != nil {
		s.log.Printf("sweep ledger: %v", err)
		return 0
	}
	for _, e := range expired {
		if e.FilePath != "" {
			if err := os.Remove(e.FilePath); err != nil && !os.IsNotExist(err) {
				s.log.Printf("sweep remove %s: %v", e.FilePath, err)
			} else {
				s.log.Printf("sweep expired keyId=%s jobId=%s", e.KeyID, e.JobID)
			}
		}
	}
	return len(expired)
}

// StartSweeper runs SweepOnce every interval until stop is closed.
func (s *Server) StartSweeper(interval time.Duration, stop <-chan struct{}) {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			n := s.SweepOnce()
			if n > 0 {
				s.log.Printf("sweep purged %d key(s)", n)
			}
		}
	}
}

func randomKeyID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
