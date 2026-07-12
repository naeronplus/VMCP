package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bits-and-blooms/bloom/v3"
)

func testAgent(t *testing.T, projectRoot string) *Agent {
	t.Helper()
	return &Agent{
		cfg: Config{
			ProjectRoot:    projectRoot,
			AllowedStaging: t.TempDir(),
			NonceLogPath:   filepath.Join(t.TempDir(), "nonces.log"),
			PGOSBaseURL:    "http://127.0.0.1:9",
		},
		bloom:  bloom.NewWithEstimates(1000, 0.01),
		nonces: make(map[string]struct{}),
		slog:   log.New(io.Discard, "", 0),
	}
}

func TestPendingSidecarWriteAndRecovery(t *testing.T) {
	stagingDir := filepath.Join(t.TempDir(), "staging-job-test")
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		t.Fatal(err)
	}

	req := CommitRequest{
		Token:  "fence-token",
		Source: stagingDir,
		Target: filepath.Join(t.TempDir(), "live-project"),
		Nonce:  "nonce-1",
		JobID:  "job-test",
	}
	sidecarPath := filepath.Join(stagingDir, ".pgos-pending-commit")
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sidecarPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(sidecarPath)
	if err != nil {
		t.Fatal(err)
	}
	var recovered CommitRequest
	if err := json.Unmarshal(raw, &recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Token != req.Token || recovered.Source != req.Source {
		t.Fatalf("recovery mismatch: %+v", recovered)
	}
}

func TestHandleArgsRejectsUnknownVerb(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"rm", "-rf", "/"})
	if code == 0 {
		t.Fatal("expected reject")
	}
	if !strings.Contains(msg, "unknown verb") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestStageReceiveAndPathTraversal(t *testing.T) {
	a := testAgent(t, t.TempDir())
	// traversal dest rejected
	code, _ := a.handleArgs([]string{"stage-receive", filepath.Join(a.cfg.AllowedStaging, "..", "etc"), strings.Repeat("a", 64)})
	if code == 0 {
		t.Fatal("expected path reject")
	}

	// happy path: empty project tar
	payload, sum := makeTarGz(t, map[string]string{"hello.txt": "world"})
	dest := filepath.Join(a.cfg.AllowedStaging, "staging-job1")
	old := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = r
	go func() {
		_, _ = w.Write(payload)
		_ = w.Close()
	}()
	code, msg := a.handleArgs([]string{"stage-receive", dest, sum})
	os.Stdin = old
	if code != 0 {
		t.Fatalf("stage-receive failed: %s", msg)
	}
	b, err := os.ReadFile(filepath.Join(dest, "hello.txt"))
	if err != nil || string(b) != "world" {
		t.Fatalf("extract mismatch: %v %q", err, b)
	}
}

func TestCommitRetainsBackupAndUsesEnvOwner(t *testing.T) {
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)

	var gotOwner, gotKey string
	validateTokenFn = func(_ *Agent, lockKey, owner, token string) (bool, error) {
		gotKey = lockKey
		gotOwner = owner
		return token == "tok-ok", nil
	}
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })

	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:project-1")
	t.Setenv("PGOS_LOCK_OWNER", "job:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	t.Setenv("PGOS_JOB_ID", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

	staging := filepath.Join(a.cfg.AllowedStaging, "staging-c1")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "a.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(projectRoot, "p1")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, msg := a.handleArgs([]string{"commit", "tok-ok", staging, target})
	if code != 0 {
		t.Fatalf("commit failed: %s", msg)
	}
	if gotOwner != "job:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" || gotKey != "gen:project-1" {
		t.Fatalf("fencing identity not from env: key=%q owner=%q", gotKey, gotOwner)
	}
	bak := target + ".bak-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	if _, err := os.Stat(bak); err != nil {
		t.Fatalf("expected retained backup %s: %v", bak, err)
	}
	if _, err := os.Stat(filepath.Join(target, "a.txt")); err != nil {
		t.Fatal("new content missing")
	}
}

func TestCommitArgsOverrideLockOwner(t *testing.T) {
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	var gotOwner string
	validateTokenFn = func(_ *Agent, _, owner, token string) (bool, error) {
		gotOwner = owner
		return true, nil
	}
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_OWNER", "job:env-owner")

	staging := filepath.Join(a.cfg.AllowedStaging, "staging-c2")
	_ = os.MkdirAll(staging, 0o755)
	_ = os.WriteFile(filepath.Join(staging, "x"), []byte("1"), 0o644)
	target := filepath.Join(projectRoot, "p2")

	code, msg := a.handleArgs([]string{
		"commit", "t", staging, target,
		"lock-from-args", "job:from-args", "nonce-x",
	})
	if code != 0 {
		t.Fatalf("commit failed: %s", msg)
	}
	if gotOwner != "job:from-args" {
		t.Fatalf("expected args owner, got %q", gotOwner)
	}
}

func TestRestoreFromBackup(t *testing.T) {
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	target := filepath.Join(projectRoot, "live")
	bak := target + ".bak-job1"
	_ = os.MkdirAll(bak, 0o755)
	_ = os.WriteFile(filepath.Join(bak, "snap.txt"), []byte("snap"), 0o644)
	_ = os.MkdirAll(target, 0o755)
	_ = os.WriteFile(filepath.Join(target, "bad.txt"), []byte("bad"), 0o644)

	code, msg := a.handleArgs([]string{"restore", target, bak})
	if code != 0 {
		t.Fatalf("restore failed: %s", msg)
	}
	b, err := os.ReadFile(filepath.Join(target, "snap.txt"))
	if err != nil || string(b) != "snap" {
		t.Fatalf("restore content: %v %q", err, b)
	}
}

func TestReimportRejectsTraversal(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"reimport", filepath.Join(a.cfg.ProjectRoot, "..", "etc"), "5"})
	if code == 0 {
		t.Fatal("expected reject")
	}
	if !strings.Contains(msg, "outside") && !strings.Contains(msg, "traversal") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestValidateTokenHTTPMock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/locks/validate-token" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"valid": true})
	}))
	t.Cleanup(srv.Close)

	a := testAgent(t, t.TempDir())
	a.cfg.PGOSBaseURL = srv.URL
	ok, err := defaultValidateToken(a, "k", "job:x", "tok")
	if err != nil || !ok {
		t.Fatalf("validate: ok=%v err=%v", ok, err)
	}
}

func makeTarGz(t *testing.T, files map[string]string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:])
}
