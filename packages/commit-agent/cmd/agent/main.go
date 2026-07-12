// Privileged commit agent (§4.2).
// ForcedCommand / -once verbs (no shell):
//
//	stage-receive <dest_dir> <sha256>     # tar.gz on stdin
//	commit <token> <source> <target> [lockKey lockOwner [nonce]]
//	reimport <project_path> <timeout_sec>
//	restore <target_dir> [backup_path]   # tar.gz on stdin if no backup_path
//
// Over Unix domain socket: same argv-style or JSON commit protocol.
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
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
	cmdCommit       = "commit"
	cmdStageReceive = "stage-receive"
	cmdReimport     = "reimport"
	cmdRestore      = "restore"
)

// validateTokenFn is swappable in tests.
var validateTokenFn = defaultValidateToken

type Config struct {
	SocketPath     string
	ProjectRoot    string
	PGOSBaseURL    string
	AuthToken      string
	LockKey        string
	Owner          string
	NonceLogPath   string
	AllowedStaging string
}

type CommitRequest struct {
	Token    string `json:"token"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	Nonce    string `json:"nonce"`
	JobID    string `json:"jobId"`
	LockKey  string `json:"lockKey,omitempty"`
	LockOwner string `json:"lockOwner,omitempty"`
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
	pgosURL := flag.String("pgos-url", envOr("PGOS_URL", "http://localhost:8080"), "PGOS base URL")
	authToken := flag.String("auth-token", os.Getenv("PGOS_AGENT_TOKEN"), "Bearer token for fencing validation")
	lockKey := flag.String("lock-key", "", "Default lock key (optional override per request via env)")
	owner := flag.String("owner", "", "Default lock owner")
	nonceLog := flag.String("nonce-log", "/var/lib/pgos-agent/nonces.log", "Persistent nonce log")
	once := flag.String("once", "", "Run single command line (SSH ForcedCommand mode)")
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
		// SSH ForcedCommand / commit-agent-once mode (prefer SSH_ORIGINAL_COMMAND)
		parts := resolveOnceParts(*once)
		code, msg := a.handleArgs(parts)
		// reimport already streamed logs to stdout; still print status line
		fmt.Fprintln(os.Stdout, msg)
		os.Exit(code)
	}

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

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func resolveOnceParts(onceFlag string) []string {
	if soc := os.Getenv("SSH_ORIGINAL_COMMAND"); soc != "" {
		return strings.Fields(soc)
	}
	if flag.NArg() > 0 {
		return flag.Args()
	}
	return strings.Fields(onceFlag)
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
	switch parts[0] {
	case cmdCommit:
		return a.handleCommitArgs(parts)
	case cmdStageReceive:
		return a.handleStageReceive(parts)
	case cmdReimport:
		return a.handleReimport(parts)
	case cmdRestore:
		return a.handleRestore(parts)
	default:
		return 1, "unknown verb (allowed: stage-receive, commit, reimport, restore)"
	}
}

func (a *Agent) handleCommitArgs(parts []string) (int, string) {
	// commit <token> <source> <target> [lockKey lockOwner [nonce]]
	if len(parts) != 4 && len(parts) != 6 && len(parts) != 7 {
		return 1, "usage: commit <token> <source_temp_dir> <target_dir> [lockKey lockOwner [nonce]]"
	}
	req := CommitRequest{
		Token:  parts[1],
		Source: parts[2],
		Target: parts[3],
		Nonce:  os.Getenv("PGOS_COMMIT_NONCE"),
		JobID:  os.Getenv("PGOS_JOB_ID"),
	}
	if len(parts) >= 6 {
		req.LockKey = parts[4]
		req.LockOwner = parts[5]
	}
	if len(parts) == 7 {
		req.Nonce = parts[6]
	}
	return a.doCommit(req)
}

func (a *Agent) handleStageReceive(parts []string) (int, string) {
	if len(parts) != 3 {
		return 1, "usage: stage-receive <dest_dir> <sha256>"
	}
	dest, err := paths.ValidateStagingDest(parts[1], a.cfg.AllowedStaging)
	if err != nil {
		return 1, err.Error()
	}
	wantSum := strings.ToLower(strings.TrimSpace(parts[2]))
	if len(wantSum) != 64 {
		return 1, "sha256 must be 64 hex chars"
	}

	archivePath := filepath.Join(a.cfg.AllowedStaging, fmt.Sprintf("stage-recv-%d.tar.gz", time.Now().UnixNano()))
	af, err := os.OpenFile(archivePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 1, "create archive temp: " + err.Error()
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(af, h), os.Stdin); err != nil {
		af.Close()
		_ = os.Remove(archivePath)
		return 1, "read stdin: " + err.Error()
	}
	if err := af.Close(); err != nil {
		_ = os.Remove(archivePath)
		return 1, err.Error()
	}
	defer os.Remove(archivePath)

	got := hex.EncodeToString(h.Sum(nil))
	if got != wantSum {
		return 1, fmt.Sprintf("checksum mismatch got=%s want=%s", got, wantSum)
	}

	_ = os.RemoveAll(dest)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return 1, "mkdir dest: " + err.Error()
	}
	rf, err := os.Open(archivePath)
	if err != nil {
		_ = os.RemoveAll(dest)
		return 1, err.Error()
	}
	defer rf.Close()
	if err := extractTarGz(rf, dest); err != nil {
		_ = os.RemoveAll(dest)
		return 1, "extract: " + err.Error()
	}
	a.slog.Printf("stage-receive ok dest=%s", dest)
	return 0, "staged " + dest
}

func extractTarGz(r io.Reader, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		// Refuse absolute paths and traversal
		name := filepath.Clean(hdr.Name)
		if strings.HasPrefix(name, "..") || filepath.IsAbs(name) {
			return fmt.Errorf("unsafe tar entry: %s", hdr.Name)
		}
		target := filepath.Join(dest, name)
		if !strings.HasPrefix(target, dest+string(filepath.Separator)) && target != dest {
			return fmt.Errorf("tar entry escapes dest: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		default:
			// skip other types
		}
	}
}

func (a *Agent) handleReimport(parts []string) (int, string) {
	if len(parts) != 3 {
		return 1, "usage: reimport <project_path> <timeout_sec>"
	}
	projectPath, err := paths.ValidateTarget(parts[1], a.cfg.ProjectRoot)
	if err != nil {
		return 1, err.Error()
	}
	var timeoutSec int
	if _, err := fmt.Sscanf(parts[2], "%d", &timeoutSec); err != nil || timeoutSec <= 0 {
		return 1, "timeout_sec must be positive integer"
	}

	godotBin := os.Getenv("GODOT_BIN")
	if godotBin == "" {
		godotBin = "godot"
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, godotBin, "--headless", "--editor", "--quit", "--path", projectPath)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err = cmd.Run()
	// Always stream log to stdout for the worker to capture
	fmt.Fprint(os.Stdout, buf.String())
	if ctx.Err() == context.DeadlineExceeded {
		return 1, "reimport timeout"
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), "reimport failed"
		}
		return 1, "reimport error: " + err.Error()
	}
	return 0, "reimport ok"
}

func (a *Agent) handleRestore(parts []string) (int, string) {
	// restore <target_dir> [backup_path]
	if len(parts) != 2 && len(parts) != 3 {
		return 1, "usage: restore <target_dir> [backup_path]"
	}
	target, err := paths.ValidateTarget(parts[1], a.cfg.ProjectRoot)
	if err != nil {
		return 1, err.Error()
	}

	if len(parts) == 3 {
		backup, err := paths.ValidateBackupPath(parts[2], a.cfg.ProjectRoot, a.cfg.AllowedStaging)
		if err != nil {
			return 1, err.Error()
		}
		if _, err := os.Stat(backup); err != nil {
			return 1, "backup missing: " + err.Error()
		}
		_ = os.RemoveAll(target)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return 1, err.Error()
		}
		if err := os.Rename(backup, target); err != nil {
			// fallback copy for cross-device
			if err2 := copyDir(backup, target); err2 != nil {
				return 1, "restore rename/copy failed: " + err2.Error()
			}
			_ = os.RemoveAll(backup)
		}
		return 0, "restored from backup"
	}

	// stdin tar.gz of previous project tree
	tmp := filepath.Join(a.cfg.AllowedStaging, fmt.Sprintf("restore-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return 1, err.Error()
	}
	defer os.RemoveAll(tmp)
	if err := extractTarGz(os.Stdin, tmp); err != nil {
		return 1, "extract restore archive: " + err.Error()
	}
	_ = os.RemoveAll(target)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return 1, err.Error()
	}
	if err := os.Rename(tmp, target); err != nil {
		if err2 := copyDir(tmp, target); err2 != nil {
			return 1, "restore place failed: " + err2.Error()
		}
	}
	return 0, "restored from archive"
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(out, info.Mode())
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(f, in)
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func (a *Agent) doCommit(req CommitRequest) (int, string) {
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

	nonce := req.Nonce
	if nonce == "" {
		nonce = req.JobID + ":" + req.Token
	}
	if a.seenNonce(nonce) {
		a.slog.Printf("replay rejected nonce=%s", nonce)
		return 1, "replay rejected"
	}

	lockKey := req.LockKey
	if lockKey == "" {
		lockKey = a.cfg.LockKey
	}
	if lockKey == "" {
		lockKey = os.Getenv("PGOS_LOCK_KEY")
	}
	owner := req.LockOwner
	if owner == "" {
		owner = a.cfg.Owner
	}
	if owner == "" {
		owner = os.Getenv("PGOS_LOCK_OWNER")
	}
	// Redacted audit: log owner/key lengths only
	a.slog.Printf("fencing identity lockKeyLen=%d ownerLen=%d ownerPrefix=%s",
		len(lockKey), len(owner), redactOwner(owner))

	requireFencing := os.Getenv("PGOS_REQUIRE_FENCING") == "true" ||
		os.Getenv("PGOS_REQUIRE_FENCING") == "1"
	if requireFencing && (lockKey == "" || owner == "") {
		a.slog.Printf("fencing required but lock key/owner missing token=%s", req.Token)
		return 1, "fencing validation required but PGOS_LOCK_KEY/PGOS_LOCK_OWNER not configured"
	}
	if lockKey != "" && owner != "" {
		ok, err := validateTokenFn(a, lockKey, owner, req.Token)
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
		if _, err2 := os.Stat(target); err2 == nil {
			a.recordNonce(nonce)
			a.slog.Printf("idempotent success (target exists, source gone) token=%s", req.Token)
			return 0, "already committed"
		}
		return 1, "source does not exist"
	}

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

	// Retain job-scoped backup for post-commit rollback (C-03).
	// S3 snapshot is primary; target.bak-{jobId} is secondary on the host.
	jobID := req.JobID
	if jobID == "" {
		jobID = os.Getenv("PGOS_JOB_ID")
	}
	if jobID == "" {
		jobID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	backup := target + ".bak-" + jobID
	// Remove previous bak for same job id if re-running; keep other jobs' baks
	if _, err := os.Stat(backup); err == nil {
		_ = os.RemoveAll(backup)
	}
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
	// Intentionally retain backup until next commit for this job path (post-commit verify).
	_ = os.Remove(sidecarPath)

	a.recordNonce(nonce)
	a.slog.Printf("commit ok token=%s source=%s target=%s backup=%s", req.Token, source, target, backup)
	return 0, "committed backup=" + backup
}

func redactOwner(owner string) string {
	if owner == "" {
		return ""
	}
	if len(owner) <= 8 {
		return owner[:1] + "***"
	}
	return owner[:8] + "…"
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

func defaultValidateToken(a *Agent, lockKey, owner, token string) (bool, error) {
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
