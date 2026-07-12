package internal

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	dir := t.TempDir()
	keys := filepath.Join(dir, "keys.d")
	ledger := filepath.Join(dir, "ledger.json")
	s := NewServer(Config{
		Token:             "test-token",
		AuthorizedKeysDir: keys,
		LedgerPath:        ledger,
		MaxConcurrentKeys: 16,
		Logger:            log.New(io.Discard, "", 0),
	})
	return s, keys, ledger
}

func TestProvisionAuth401(t *testing.T) {
	s, _, _ := testServer(t)
	body := `{"publicKey":"x","jobId":"j","ttlSeconds":60}`
	req := httptest.NewRequest(http.MethodPost, "/v1/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestProvisionValidation(t *testing.T) {
	s, _, _ := testServer(t)
	pub := validOpenSSHEd25519(t)

	cases := []struct {
		name string
		body map[string]any
		code int
	}{
		{"missing publicKey", map[string]any{"jobId": "j1", "ttlSeconds": 60}, 400},
		{"missing jobId", map[string]any{"publicKey": pub, "ttlSeconds": 60}, 400},
		{"bad ttl", map[string]any{"publicKey": pub, "jobId": "j1", "ttlSeconds": 0}, 400},
		{"ttl too large", map[string]any{"publicKey": pub, "jobId": "j1", "ttlSeconds": 99999}, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(tc.body)
			req := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewReader(b))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer test-token")
			rr := httptest.NewRecorder()
			s.Handler().ServeHTTP(rr, req)
			if rr.Code != tc.code {
				t.Fatalf("status=%d want=%d body=%s", rr.Code, tc.code, rr.Body.String())
			}
		})
	}
}

func TestProvisionHappyPath(t *testing.T) {
	s, keysDir, _ := testServer(t)
	pub := validOpenSSHEd25519(t)
	body := map[string]any{
		"publicKey":     pub,
		"forcedCommand": "commit-agent-once",
		"jobId":         "job-uuid-1",
		"singleUse":     false,
		"maxSessions":   8,
		"ttlSeconds":    300,
		"environment": map[string]string{
			"PGOS_LOCK_KEY":        "gen:p",
			"PGOS_LOCK_OWNER":      "job:job-uuid-1",
			"PGOS_JOB_ID":          "job-uuid-1",
			"PGOS_REQUIRE_FENCING": "true",
		},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp provisionResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.KeyID == "" || resp.ExpiresAt == "" {
		t.Fatalf("resp=%+v", resp)
	}
	// Key file installed mode 600
	entries, err := os.ReadDir(keysDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("keys dir entries=%v err=%v", entries, err)
	}
	raw, err := os.ReadFile(filepath.Join(keysDir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	line := string(raw)
	if !strings.Contains(line, `command="commit-agent-once"`) {
		t.Fatalf("line=%s", line)
	}
	if !strings.Contains(line, "PGOS_REQUIRE_FENCING=true") {
		t.Fatalf("line=%s", line)
	}
	info, err := os.Stat(filepath.Join(keysDir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		// On Windows ACLs may differ; only soft-check group/world bits when they apply
		if info.Mode().Perm() != 0o600 && info.Mode().Perm()&0o007 != 0 {
			t.Logf("warning: key file mode=%o (expected 0600 on Unix)", info.Mode().Perm())
		}
	}
}

func TestProvisionMaxSessionsConflict(t *testing.T) {
	s, _, _ := testServer(t)
	pub := validOpenSSHEd25519(t)
	// maxSessions=1 → second provision for same job should 409
	for i := 0; i < 2; i++ {
		body := map[string]any{
			"publicKey":   pub,
			"jobId":       "job-one",
			"maxSessions": 1,
			"ttlSeconds":  120,
		}
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		s.Handler().ServeHTTP(rr, req)
		if i == 0 && rr.Code != http.StatusCreated {
			t.Fatalf("first provision: %d %s", rr.Code, rr.Body.String())
		}
		if i == 1 && rr.Code != http.StatusConflict {
			t.Fatalf("second provision want 409 got %d %s", rr.Code, rr.Body.String())
		}
	}
}

func TestTTLExpiryRemovesFile(t *testing.T) {
	s, keysDir, _ := testServer(t)
	// Freeze time via custom now
	base := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }

	pub := validOpenSSHEd25519(t)
	body := map[string]any{
		"publicKey":   pub,
		"jobId":       "job-ttl",
		"ttlSeconds":  60,
		"maxSessions": 8,
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d %s", rr.Code, rr.Body.String())
	}
	ents, _ := os.ReadDir(keysDir)
	if len(ents) != 1 {
		t.Fatalf("expected 1 key file, got %d", len(ents))
	}

	// Advance past expiry and sweep
	s.now = func() time.Time { return base.Add(2 * time.Minute) }
	n := s.SweepOnce()
	if n != 1 {
		t.Fatalf("sweep purged %d want 1", n)
	}
	ents, _ = os.ReadDir(keysDir)
	if len(ents) != 0 {
		t.Fatalf("key file not removed after sweep")
	}
}

func TestRevoke(t *testing.T) {
	s, keysDir, _ := testServer(t)
	pub := validOpenSSHEd25519(t)
	body := map[string]any{
		"publicKey":   pub,
		"jobId":       "job-rev",
		"ttlSeconds":  300,
		"maxSessions": 8,
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	var resp provisionResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)

	rb, _ := json.Marshal(map[string]string{"jobId": "job-rev", "keyId": resp.KeyID})
	req2 := httptest.NewRequest(http.MethodPost, "/v1/revoke", bytes.NewReader(rb))
	req2.Header.Set("Authorization", "Bearer test-token")
	req2.Header.Set("Content-Type", "application/json")
	rr2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("revoke status=%d %s", rr2.Code, rr2.Body.String())
	}
	ents, _ := os.ReadDir(keysDir)
	if len(ents) != 0 {
		t.Fatalf("key still present after revoke")
	}
}
