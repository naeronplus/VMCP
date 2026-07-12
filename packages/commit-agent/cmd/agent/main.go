// Minimal privileged commit agent (§4.2).
// Accepts only: commit <token> <source_temp_dir> <target_dir>
// over Unix domain socket or as SSH forced command.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bits-and-blooms/bloom/v3"
	paths "github.com/vibrato/pgos/commit-agent/internal"
)

const maxSocketLineBytes = 64 * 1024

const (
	cmdCommit = "commit"
)

type Config struct {
	SocketPath      string
	ProjectRoot     string
	PGOSBaseURL     string
	AuthToken       string
	LockKey         string
	Owner           string
	NonceLogPath    string
	AllowedStaging  string
}

type CommitRequest struct {
	Token  string `json:"token"`
	Source string `json:"source"`
	Target string `json:"target"`
	Nonce  string `json:"nonce"`
	JobID  string `json:"jobId"`
}

type Agent struct {
	cfg    Config
	bloom  *bloom.BloomFilter
	mu     sync.Mutex
	nonces map[string]struct{}
	slog   *log.Logger
}

func main() {
	socket := flag.String("socket", "/var/run/pgos-commit-agent.sock", "Unix domain socket path")
	projectRoot := flag.String("project-root", "/var/godot/projects", "Allowed project root")
	pgosURL := flag.String("pgos-url", "http://localhost:8080", "PGOS base URL")
	authToken := flag.String("auth-token", os.Getenv("PGOS_AGENT_TOKEN"), "Bearer token for fencing validation")
	lockKey := flag.String("lock-key", "", "Default lock key (optional override per request via env)")
	owner := flag.String("owner", "", "Default lock owner")
	nonceLog := flag.String("nonce-log", "/var/lib/pgos-agent/nonces.log", "Persistent nonce log")
	once := flag.String("once", "", "Run single command line: commit <token> <src> <dst>")
	flag.Parse()

	cfg := Config{
		SocketPath:     *socket,
		ProjectRoot:    *projectRoot,
		PGOSBaseURL:    strings.TrimRight(*pgosURL, "/"),
		AuthToken:      *authToken,
		LockKey:        *lockKey,
		Owner:          *owner,
		NonceLogPath:   *nonceLog,
		AllowedStaging: "/tmp",
	}

	// syslog is Unix-only; on Windows (and when syslog unavailable) use stderr.
	// Production Linux systemd units still capture journal via stdout/stderr.
	slog := log.New(os.Stderr, "pgos-commit-agent: ", log.LstdFlags)
	if runtime.GOOS != "windows" {
		if sysw, err := trySyslog(); err == nil {
			slog = log.New(sysw, "", 0)
		}
	}

	a := &Agent{
		cfg:    cfg,
		bloom:  bloom.NewWithEstimates(100_000, 0.001),
		nonces: make(map[string]struct{}),
		slog:   slog,
	}
	a.loadNonceLog()

	if *once != "" {
		// SSH forced command mode
		parts := strings.Fields(*once)
		if len(os.Args) > 1 && flag.NArg() > 0 {
			parts = flag.Args()
		}
		// Also accept full command from SSH_ORIGINAL_COMMAND
		if soc := os.Getenv("SSH_ORIGINAL_COMMAND"); soc != "" {
			parts = strings.Fields(soc)
		}
		if len(parts) == 0 {
			parts = strings.Fields(*once)
		}
		code, msg := a.handleArgs(parts)
		fmt.Fprintln(os.Stdout, msg)
		os.Exit(code)
	}

	// Recover incomplete renames after crash (§4.2.1 failure recovery)
	a.recoverPendingRenames()

	_ = os.Remove(cfg.SocketPath)
	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0o755); err != nil {
		log.Fatalf("mkdir socket dir: %v", err)
	}
	ln, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	_ = os.Chmod(cfg.SocketPath, 0o660)
	slog.Printf("listening on %s", cfg.SocketPath)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				slog.Printf("accept error: %v", err)
				continue
			}
		}
		go a.handleConn(conn)
	}
}

func (a *Agent) handleConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(conn)
	line, err := readLimitedLine(reader, maxSocketLineBytes)
	if err != nil && err != io.EOF {
		a.slog.Printf("read error: %v", err)
		return
	}
	line = strings.TrimSpace(line)
	// Support JSON protocol or argv-style
	if strings.HasPrefix(line, "{") {
		var req CommitRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintln(conn, "ERR invalid json")
			return
		}
		code, msg := a.doCommit(req)
		if code == 0 {
			fmt.Fprintln(conn, "OK "+msg)
		} else {
			fmt.Fprintf(conn, "ERR %s\n", msg)
		}
		return
	}
	parts := strings.Fields(line)
	code, msg := a.handleArgs(parts)
	if code == 0 {
		fmt.Fprintln(conn, "OK "+msg)
	} else {
		fmt.Fprintf(conn, "ERR %s\n", msg)
	}
}

func (a *Agent) handleArgs(parts []string) (int, string) {
	if len(parts) < 1 {
		return 1, "empty command"
	}
	if parts[0] != cmdCommit {
		return 1, "only 'commit' is allowed"
	}
	if len(parts) != 4 {
		return 1, "usage: commit <token> <source_temp_dir> <target_dir>"
	}
	return a.doCommit(CommitRequest{
		Token:  parts[1],
		Source: parts[2],
		Target: parts[3],
		Nonce:  os.Getenv("PGOS_COMMIT_NONCE"),
		JobID:  os.Getenv("PGOS_JOB_ID"),
	})
}

func (a *Agent) doCommit(req CommitRequest) (int, string) {
	// Injection hardening: no shell; strict path validation
	source, err := paths.ValidateStagingSource(req.Source)
	if err != nil {
		a.slog.Printf("reject source: %v token=%s", err, req.Token)
		return 1, err.Error()
	}
	target, err := paths.ValidateTarget(req.Target, a.cfg.ProjectRoot)
	if err != nil {
		a.slog.Printf("reject target: %v token=%s", err, req.Token)
		return 1, err.Error()
	}

	// Replay protection
	nonce := req.Nonce
	if nonce == "" {
		nonce = req.JobID + ":" + req.Token
	}
	if a.seenNonce(nonce) {
		a.slog.Printf("replay rejected nonce=%s", nonce)
		return 1, "replay rejected"
	}

	// Validate fencing token against Postgres via PGOS
	lockKey := a.cfg.LockKey
	if lockKey == "" {
		lockKey = os.Getenv("PGOS_LOCK_KEY")
	}
	owner := a.cfg.Owner
	if owner == "" {
		owner = os.Getenv("PGOS_LOCK_OWNER")
	}
	requireFencing := os.Getenv("PGOS_REQUIRE_FENCING") == "true" ||
		os.Getenv("PGOS_REQUIRE_FENCING") == "1"
	if requireFencing && (lockKey == "" || owner == "") {
		a.slog.Printf("fencing required but lock key/owner missing token=%s", req.Token)
		return 1, "fencing validation required but PGOS_LOCK_KEY/PGOS_LOCK_OWNER not configured"
	}
	if lockKey != "" && owner != "" {
		ok, err := a.validateToken(lockKey, owner, req.Token)
		if err != nil {
			return 1, "token validation error: " + err.Error()
		}
		if !ok {
			a.slog.Printf("fencing token rejected token=%s", req.Token)
			return 1, "fencing token rejected"
		}
	} else if requireFencing {
		return 1, "fencing validation required"
	}

	if _, err := os.Stat(source); err != nil {
		// If source gone, rename may have already succeeded
		if _, err2 := os.Stat(target); err2 == nil {
			a.recordNonce(nonce)
			a.slog.Printf("idempotent success (target exists, source gone) token=%s", req.Token)
			return 0, "already committed"
		}
		return 1, "source does not exist"
	}

	// Pending sidecar for crash recovery (§4.2.1)
	sidecarDir := filepath.Dir(source)
	sidecarPath := filepath.Join(sidecarDir, ".pgos-pending-commit")
	pending := req
	pending.Source = source
	pending.Target = target
	if pending.Nonce == "" {
		pending.Nonce = nonce
	}
	pendingBytes, _ := json.Marshal(pending)
	if err := os.WriteFile(sidecarPath, pendingBytes, 0o600); err != nil {
		return 1, "failed to write pending sidecar: " + err.Error()
	}

	// Atomic rename on same filesystem
	backup := target + ".pgos-bak-" + fmt.Sprintf("%d", time.Now().UnixNano())
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, backup); err != nil {
			_ = os.Remove(sidecarPath)
			return 1, "failed to move target aside: " + err.Error()
		}
	}
	if err := os.Rename(source, target); err != nil {
		if _, err2 := os.Stat(backup); err2 == nil {
			_ = os.Rename(backup, target)
		}
		a.slog.Printf("rename failed token=%s err=%v", req.Token, err)
		return 1, "rename failed: " + err.Error()
	}
	if _, err := os.Stat(backup); err == nil {
		_ = os.RemoveAll(backup)
	}
	_ = os.Remove(sidecarPath)

	a.recordNonce(nonce)
	a.slog.Printf("commit ok token=%s source=%s target=%s", req.Token, source, target)
	return 0, "committed"
}

func readLimitedLine(r *bufio.Reader, max int) (string, error) {
	var out []byte
	for {
		b, err := r.ReadByte()
		if err != nil {
			if err == io.EOF && len(out) > 0 {
				return string(out), nil
			}
			return "", err
		}
		if b == '\n' {
			return string(out), nil
		}
		out = append(out, b)
		if len(out) > max {
			return "", fmt.Errorf("line exceeds %d bytes", max)
		}
	}
}

func (a *Agent) validateToken(lockKey, owner, token string) (bool, error) {
	body, _ := json.Marshal(map[string]string{
		"lockKey": lockKey,
		"owner":   owner,
		"token":   token,
	})
	req, err := http.NewRequest(http.MethodPost, a.cfg.PGOSBaseURL+"/api/v1/locks/validate-token", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if a.cfg.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.AuthToken)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return false, fmt.Errorf("pgos auth failed: HTTP %d", res.StatusCode)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, fmt.Errorf("pgos validate-token HTTP %d", res.StatusCode)
	}
	var out struct {
		Valid bool `json:"valid"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return false, err
	}
	return out.Valid, nil
}

func (a *Agent) seenNonce(n string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.nonces[n]; ok {
		return true
	}
	if a.bloom.Test([]byte(n)) {
		// Possible false positive — check persistent log
		return a.nonceInLog(n)
	}
	return false
}

func (a *Agent) recordNonce(n string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nonces[n] = struct{}{}
	a.bloom.Add([]byte(n))
	_ = os.MkdirAll(filepath.Dir(a.cfg.NonceLogPath), 0o755)
	f, err := os.OpenFile(a.cfg.NonceLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintln(f, n)
}

func (a *Agent) loadNonceLog() {
	data, err := os.ReadFile(a.cfg.NonceLogPath)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		a.nonces[line] = struct{}{}
		a.bloom.Add([]byte(line))
	}
}

func (a *Agent) nonceInLog(n string) bool {
	_, ok := a.nonces[n]
	return ok
}

func (a *Agent) recoverPendingRenames() {
	// Scan /tmp for staging-* dirs with sidecar .pgos-pending-commit JSON
	entries, err := os.ReadDir("/tmp")
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "staging-") {
			continue
		}
		meta := filepath.Join("/tmp", e.Name(), ".pgos-pending-commit")
		data, err := os.ReadFile(meta)
		if err != nil {
			continue
		}
		var req CommitRequest
		if json.Unmarshal(data, &req) != nil {
			continue
		}
		a.slog.Printf("recovering pending commit for %s", e.Name())
		code, msg := a.doCommit(req)
		a.slog.Printf("recovery result code=%d msg=%s", code, msg)
	}
}
