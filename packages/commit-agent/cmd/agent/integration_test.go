// M-16: Commit-agent integration tests (plan §7.6)
//
//	7.6.1 HTTP mock fencing validation
//	7.6.2 doCommit idempotency
//	7.6.3 Replay rejection
//	7.6.4 Path traversal
//	7.6.5 -once + multi-verb + SSH_ORIGINAL_COMMAND
//
// DoD: go test ./... covers commit paths beyond sidecar JSON.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// ---------------------------------------------------------------------------
// 7.6.1 HTTP mock fencing validation
// ---------------------------------------------------------------------------

func TestFencingValidateTokenHTTP_Valid(t *testing.T) {
	var sawAuth string
	var sawBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/locks/validate-token" {
			http.NotFound(w, r)
			return
		}
		sawAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&sawBody)
		_ = json.NewEncoder(w).Encode(map[string]bool{"valid": true})
	}))
	t.Cleanup(srv.Close)

	a := testAgent(t, t.TempDir())
	a.cfg.PGOSBaseURL = srv.URL
	a.cfg.AuthToken = "agent-jwt"
	ok, err := defaultValidateToken(a, "gen:proj", "job:uuid-1", "fence-tok")
	if err != nil || !ok {
		t.Fatalf("expected valid: ok=%v err=%v", ok, err)
	}
	if sawAuth != "Bearer agent-jwt" {
		t.Fatalf("expected bearer auth, got %q", sawAuth)
	}
	if sawBody["lockKey"] != "gen:proj" || sawBody["owner"] != "job:uuid-1" || sawBody["token"] != "fence-tok" {
		t.Fatalf("body mismatch: %+v", sawBody)
	}
}

func TestFencingValidateTokenHTTP_Invalid(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]bool{"valid": false})
	}))
	t.Cleanup(srv.Close)

	a := testAgent(t, t.TempDir())
	a.cfg.PGOSBaseURL = srv.URL
	ok, err := defaultValidateToken(a, "k", "job:x", "bad")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if ok {
		t.Fatal("expected valid=false")
	}
}

func TestFencingValidateTokenHTTP_AuthRejected(t *testing.T) {
	for _, status := range []int{401, 403} {
		status := status
		t.Run(http.StatusText(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			t.Cleanup(srv.Close)
			a := testAgent(t, t.TempDir())
			a.cfg.PGOSBaseURL = srv.URL
			ok, err := defaultValidateToken(a, "k", "o", "t")
			if ok || err == nil {
				t.Fatalf("expected auth failure: ok=%v err=%v", ok, err)
			}
			if !strings.Contains(err.Error(), "auth failed") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestFencingValidateTokenHTTP_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	t.Cleanup(srv.Close)
	a := testAgent(t, t.TempDir())
	a.cfg.PGOSBaseURL = srv.URL
	ok, err := defaultValidateToken(a, "k", "o", "t")
	if ok || err == nil {
		t.Fatalf("expected HTTP 500 error: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("err=%v", err)
	}
}

func TestDoCommit_FencingViaHTTPMock_AcceptsAndRejects(t *testing.T) {
	var valid atomic.Bool
	valid.Store(true)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/v1/locks/validate-token" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"valid": valid.Load()})
	}))
	t.Cleanup(srv.Close)

	// Ensure real HTTP path (not validateTokenFn stub)
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	validateTokenFn = defaultValidateToken

	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	a.cfg.PGOSBaseURL = srv.URL
	a.cfg.AuthToken = "agent"

	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:p")
	t.Setenv("PGOS_LOCK_OWNER", "job:fence-http")
	t.Setenv("PGOS_JOB_ID", "fence-http")

	staging, target := prepareStagingAndTarget(t, a, projectRoot, "staging-fence", "live-fence", "v1")

	code, msg := a.doCommit(CommitRequest{
		Token:  "tok-good",
		Source: staging,
		Target: target,
		Nonce:  "nonce-fence-ok",
		JobID:  "fence-http",
	})
	if code != 0 {
		t.Fatalf("expected commit success with valid fencing: %s", msg)
	}
	if calls.Load() < 1 {
		t.Fatal("expected validate-token HTTP call")
	}

	// Rebuild staging for second attempt; fencing now returns false
	staging2 := filepath.Join(a.cfg.AllowedStaging, "staging-fence2")
	if err := os.MkdirAll(staging2, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging2, "n.txt"), []byte("n"), 0o644); err != nil {
		t.Fatal(err)
	}
	valid.Store(false)
	code, msg = a.doCommit(CommitRequest{
		Token:  "tok-bad",
		Source: staging2,
		Target: filepath.Join(projectRoot, "live-fence2"),
		Nonce:  "nonce-fence-bad",
		JobID:  "fence-http-2",
	})
	if code == 0 {
		t.Fatal("expected fencing rejection")
	}
	if !strings.Contains(msg, "fencing token rejected") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestDoCommit_FencingRequiredButMissingOwner(t *testing.T) {
	a := testAgent(t, t.TempDir())
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "")
	t.Setenv("PGOS_LOCK_OWNER", "")
	// Clear process env leftovers from other tests that set these
	_ = os.Unsetenv("PGOS_LOCK_KEY")
	_ = os.Unsetenv("PGOS_LOCK_OWNER")

	staging := filepath.Join(a.cfg.AllowedStaging, "staging-nofence")
	_ = os.MkdirAll(staging, 0o755)
	_ = os.WriteFile(filepath.Join(staging, "f"), []byte("1"), 0o644)
	target := filepath.Join(a.cfg.ProjectRoot, "t")

	code, msg := a.doCommit(CommitRequest{
		Token:  "t",
		Source: staging,
		Target: target,
		Nonce:  "n-nofence",
	})
	if code == 0 {
		t.Fatal("expected fencing required failure")
	}
	if !strings.Contains(msg, "fencing validation required") {
		t.Fatalf("msg=%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 7.6.2 doCommit idempotency
// ---------------------------------------------------------------------------

func TestDoCommit_IdempotentWhenSourceGoneTargetExists(t *testing.T) {
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	validateTokenFn = func(_ *Agent, _, _, _ string) (bool, error) { return true, nil }
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:idem")
	t.Setenv("PGOS_LOCK_OWNER", "job:idem")
	t.Setenv("PGOS_JOB_ID", "idem-job")

	staging, target := prepareStagingAndTarget(t, a, projectRoot, "staging-idem", "proj-idem", "new")

	code, msg := a.doCommit(CommitRequest{
		Token:  "tok-idem",
		Source: staging,
		Target: target,
		Nonce:  "nonce-idem-1",
		JobID:  "idem-job",
	})
	if code != 0 {
		t.Fatalf("first commit: %s", msg)
	}
	// Source was renamed away
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("source should be gone after commit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "new")); err != nil {
		t.Fatal("target content missing")
	}

	// Retry with a *fresh* nonce (same physical outcome) → already committed
	code, msg = a.doCommit(CommitRequest{
		Token:  "tok-idem",
		Source: staging,
		Target: target,
		Nonce:  "nonce-idem-2",
		JobID:  "idem-job",
	})
	if code != 0 {
		t.Fatalf("idempotent retry should succeed: %s", msg)
	}
	if !strings.Contains(msg, "already committed") {
		t.Fatalf("expected already committed, got %q", msg)
	}
}

func TestDoCommit_SourceMissingAndTargetMissingIsError(t *testing.T) {
	a := testAgent(t, t.TempDir())
	validateTokenFn = func(_ *Agent, _, _, _ string) (bool, error) { return true, nil }
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "false")
	_ = os.Unsetenv("PGOS_REQUIRE_FENCING")

	staging := filepath.Join(a.cfg.AllowedStaging, "staging-missing")
	// do not create staging
	target := filepath.Join(a.cfg.ProjectRoot, "nope")
	code, msg := a.doCommit(CommitRequest{
		Token:  "t",
		Source: staging,
		Target: target,
		Nonce:  "n-missing",
	})
	if code == 0 {
		t.Fatal("expected failure")
	}
	if !strings.Contains(msg, "source does not exist") {
		t.Fatalf("msg=%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 7.6.3 Replay rejection
// ---------------------------------------------------------------------------

func TestDoCommit_ReplayRejectedSameNonce(t *testing.T) {
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	validateTokenFn = func(_ *Agent, _, _, _ string) (bool, error) { return true, nil }
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:replay")
	t.Setenv("PGOS_LOCK_OWNER", "job:replay")
	t.Setenv("PGOS_JOB_ID", "replay-job")

	staging, target := prepareStagingAndTarget(t, a, projectRoot, "staging-replay", "proj-replay", "data")

	req := CommitRequest{
		Token:  "tok-replay",
		Source: staging,
		Target: target,
		Nonce:  "nonce-replay-same",
		JobID:  "replay-job",
	}
	code, msg := a.doCommit(req)
	if code != 0 {
		t.Fatalf("first commit: %s", msg)
	}

	// Recreate source so we would otherwise re-commit; same nonce must be blocked first
	staging2 := filepath.Join(a.cfg.AllowedStaging, "staging-replay-2")
	if err := os.MkdirAll(staging2, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging2, "data"), []byte("again"), 0o644); err != nil {
		t.Fatal(err)
	}
	req2 := req
	req2.Source = staging2
	req2.Target = filepath.Join(projectRoot, "proj-replay-2")

	code, msg = a.doCommit(req2)
	if code == 0 {
		t.Fatal("expected replay rejection")
	}
	if !strings.Contains(msg, "replay rejected") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestDoCommit_ReplayRejectedAcrossAgentReloadFromNonceLog(t *testing.T) {
	projectRoot := t.TempDir()
	nonceLog := filepath.Join(t.TempDir(), "nonces.log")
	a := testAgent(t, projectRoot)
	a.cfg.NonceLogPath = nonceLog
	validateTokenFn = func(_ *Agent, _, _, _ string) (bool, error) { return true, nil }
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:persist")
	t.Setenv("PGOS_LOCK_OWNER", "job:persist")

	staging, target := prepareStagingAndTarget(t, a, projectRoot, "staging-persist", "p-persist", "x")
	code, msg := a.doCommit(CommitRequest{
		Token: "tok-p", Source: staging, Target: target, Nonce: "nonce-persist", JobID: "j",
	})
	if code != 0 {
		t.Fatalf("commit: %s", msg)
	}

	// New agent instance loads nonce log
	a2 := testAgent(t, projectRoot)
	a2.cfg.NonceLogPath = nonceLog
	a2.cfg.AllowedStaging = a.cfg.AllowedStaging
	a2.loadNonceLog()

	staging2 := filepath.Join(a.cfg.AllowedStaging, "staging-persist-2")
	_ = os.MkdirAll(staging2, 0o755)
	_ = os.WriteFile(filepath.Join(staging2, "x"), []byte("2"), 0o644)
	code, msg = a2.doCommit(CommitRequest{
		Token: "tok-p", Source: staging2, Target: filepath.Join(projectRoot, "p2"),
		Nonce: "nonce-persist", JobID: "j",
	})
	if code == 0 || !strings.Contains(msg, "replay rejected") {
		t.Fatalf("expected persistent replay reject: code=%d msg=%s", code, msg)
	}
}

// ---------------------------------------------------------------------------
// 7.6.4 Path traversal
// ---------------------------------------------------------------------------

func TestDoCommit_RejectsTargetOutsideProjectRoot(t *testing.T) {
	a := testAgent(t, t.TempDir())
	staging := filepath.Join(a.cfg.AllowedStaging, "staging-trav")
	_ = os.MkdirAll(staging, 0o755)
	_ = os.WriteFile(filepath.Join(staging, "f"), []byte("1"), 0o644)

	code, msg := a.doCommit(CommitRequest{
		Token:  "t",
		Source: staging,
		Target: filepath.Join(a.cfg.ProjectRoot, "..", "escape"),
		Nonce:  "n-trav-target",
	})
	if code == 0 {
		t.Fatal("expected target reject")
	}
	if !strings.Contains(msg, "outside") && !strings.Contains(msg, "traversal") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestDoCommit_RejectsNonStagingSource(t *testing.T) {
	a := testAgent(t, t.TempDir())
	notStaging := filepath.Join(a.cfg.AllowedStaging, "not-a-staging-dir")
	_ = os.MkdirAll(notStaging, 0o755)
	code, msg := a.doCommit(CommitRequest{
		Token:  "t",
		Source: notStaging,
		Target: filepath.Join(a.cfg.ProjectRoot, "ok"),
		Nonce:  "n-src",
	})
	if code == 0 {
		t.Fatal("expected source reject")
	}
	if !strings.Contains(msg, "staging") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestStageReceive_RejectsChecksumMismatchAndTraversal(t *testing.T) {
	a := testAgent(t, t.TempDir())
	payload, sum := makeTarGz(t, map[string]string{"a.txt": "a"})

	// bad checksum
	old := os.Stdin
	r, w, _ := os.Pipe()
	os.Stdin = r
	go func() { _, _ = w.Write(payload); _ = w.Close() }()
	code, msg := a.handleArgs([]string{"stage-receive", filepath.Join(a.cfg.AllowedStaging, "staging-badsum"), strings.Repeat("0", 64)})
	os.Stdin = old
	if code == 0 {
		t.Fatal("expected checksum fail")
	}
	if !strings.Contains(msg, "checksum") {
		t.Fatalf("msg=%s", msg)
	}

	// dest outside allowed staging
	code, _ = a.handleArgs([]string{"stage-receive", filepath.Join(a.cfg.AllowedStaging, "..", "staging-out"), sum})
	if code == 0 {
		t.Fatal("expected dest outside reject")
	}

	// absolute-looking escape via parent in dest
	code, msg = a.handleArgs([]string{
		"stage-receive",
		filepath.Join(a.cfg.AllowedStaging, "staging-ok", "..", "..", "staging-evil"),
		sum,
	})
	if code == 0 {
		t.Fatalf("expected traversal/outside reject, got ok msg=%s", msg)
	}
}

func TestStageReceive_RejectsTarPathTraversalEntries(t *testing.T) {
	a := testAgent(t, t.TempDir())
	// Craft tar with ../ escape entry
	payload, sum := makeTarGz(t, map[string]string{
		"../evil.txt": "pwned",
		"ok.txt":      "fine",
	})
	dest := filepath.Join(a.cfg.AllowedStaging, "staging-tartest")
	old := os.Stdin
	r, w, _ := os.Pipe()
	os.Stdin = r
	go func() { _, _ = w.Write(payload); _ = w.Close() }()
	code, msg := a.handleArgs([]string{"stage-receive", dest, sum})
	os.Stdin = old
	// Should fail on unsafe entry (or succeed only if Clean collapses — must not write outside dest)
	if code == 0 {
		// If implementation skipped unsafe and continued, ensure no escape write
		evil := filepath.Join(a.cfg.AllowedStaging, "evil.txt")
		if _, err := os.Stat(evil); err == nil {
			t.Fatal("tar traversal wrote outside dest")
		}
		// Prefer failure: document if only ok.txt extracted without ../
		if _, err := os.Stat(filepath.Join(dest, "ok.txt")); err != nil {
			t.Fatalf("unexpected success without extract: %s", msg)
		}
		// Soft pass if evil blocked but ok extracted — still check evil not outside
	} else {
		if !strings.Contains(msg, "unsafe") && !strings.Contains(msg, "escape") && !strings.Contains(msg, "extract") {
			t.Fatalf("expected unsafe tar reject, msg=%s", msg)
		}
	}
}

func TestRestore_RejectsBackupOutsideRoots(t *testing.T) {
	a := testAgent(t, t.TempDir())
	target := filepath.Join(a.cfg.ProjectRoot, "live")
	_ = os.MkdirAll(target, 0o755)
	// backup outside project root and staging
	outside := filepath.Join(t.TempDir(), "sneaky-bak")
	_ = os.MkdirAll(outside, 0o755)
	_ = os.WriteFile(filepath.Join(outside, "x"), []byte("x"), 0o644)

	code, msg := a.handleArgs([]string{"restore", target, outside})
	if code == 0 {
		t.Fatal("expected backup path reject")
	}
	if !strings.Contains(msg, "outside") && !strings.Contains(msg, "traversal") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestReimport_RejectsPathOutsideRoot(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"reimport", filepath.Join(a.cfg.ProjectRoot, "..", "etc"), "1"})
	if code == 0 {
		t.Fatal("expected reject")
	}
	if !strings.Contains(msg, "outside") && !strings.Contains(msg, "traversal") {
		t.Fatalf("msg=%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 7.6.5 -once + multi-verb + SSH_ORIGINAL_COMMAND
// ---------------------------------------------------------------------------

func TestResolveOnceParts_PrefersSSHOriginalCommand(t *testing.T) {
	t.Setenv("SSH_ORIGINAL_COMMAND", "commit tok /tmp/staging-a /var/godot/projects/p")
	parts := resolveOnceParts("stage-receive /ignored abc")
	if len(parts) < 1 || parts[0] != "commit" {
		t.Fatalf("expected SSH_ORIGINAL_COMMAND commit, got %#v", parts)
	}
	if parts[1] != "tok" {
		t.Fatalf("parts=%#v", parts)
	}
}

func TestResolveOnceParts_FallsBackToOnceFlagWhenNoSSHOriginal(t *testing.T) {
	_ = os.Unsetenv("SSH_ORIGINAL_COMMAND")
	t.Setenv("SSH_ORIGINAL_COMMAND", "")
	// Ensure empty env wins for this test process
	if os.Getenv("SSH_ORIGINAL_COMMAND") != "" {
		t.Skip("cannot clear SSH_ORIGINAL_COMMAND in this environment")
	}
	parts := resolveOnceParts("reimport /var/godot/projects/p 30")
	if len(parts) != 3 || parts[0] != "reimport" {
		t.Fatalf("expected reimport from -once flag, got %#v", parts)
	}
}

func TestHandleArgs_MultiVerbSurface(t *testing.T) {
	a := testAgent(t, t.TempDir())
	// unknown
	code, msg := a.handleArgs([]string{"shell", "id"})
	if code == 0 || !strings.Contains(msg, "unknown verb") {
		t.Fatalf("unknown verb: code=%d msg=%s", code, msg)
	}
	// empty
	code, msg = a.handleArgs(nil)
	if code == 0 || !strings.Contains(msg, "empty") {
		t.Fatalf("empty: code=%d msg=%s", code, msg)
	}
	// usage errors for each verb
	if c, m := a.handleArgs([]string{"commit", "only-token"}); c == 0 || !strings.Contains(m, "usage: commit") {
		t.Fatalf("commit usage: %d %s", c, m)
	}
	if c, m := a.handleArgs([]string{"stage-receive", "only-dest"}); c == 0 || !strings.Contains(m, "usage: stage-receive") {
		t.Fatalf("stage-receive usage: %d %s", c, m)
	}
	if c, m := a.handleArgs([]string{"reimport", "only-path"}); c == 0 || !strings.Contains(m, "usage: reimport") {
		t.Fatalf("reimport usage: %d %s", c, m)
	}
	if c, m := a.handleArgs([]string{"restore"}); c == 0 || !strings.Contains(m, "usage: restore") {
		t.Fatalf("restore usage: %d %s", c, m)
	}
	if c, m := a.handleArgs([]string{"snapshot-export"}); c == 0 || !strings.Contains(m, "usage: snapshot-export") {
		t.Fatalf("snapshot-export usage: %d %s", c, m)
	}
	if c, m := a.handleArgs([]string{"stat-lock"}); c == 0 || !strings.Contains(m, "usage: stat-lock") {
		t.Fatalf("stat-lock usage: %d %s", c, m)
	}
}

func TestOnceMode_SSHOriginalCommandDrivesCommitVerb(t *testing.T) {
	// Integration of resolveOnceParts → handleArgs (what -once main path does)
	projectRoot := t.TempDir()
	a := testAgent(t, projectRoot)
	validateTokenFn = func(_ *Agent, _, _, token string) (bool, error) {
		return token == "once-tok", nil
	}
	t.Cleanup(func() { validateTokenFn = defaultValidateToken })
	t.Setenv("PGOS_REQUIRE_FENCING", "true")
	t.Setenv("PGOS_LOCK_KEY", "gen:once")
	t.Setenv("PGOS_LOCK_OWNER", "job:once")
	t.Setenv("PGOS_JOB_ID", "once-job")

	staging, target := prepareStagingAndTarget(t, a, projectRoot, "staging-once", "live-once", "payload")
	// Simulate ForcedCommand: SSH_ORIGINAL_COMMAND is authoritative
	t.Setenv("SSH_ORIGINAL_COMMAND", strings.Join([]string{
		"commit", "once-tok", staging, target,
	}, " "))
	parts := resolveOnceParts("ignored-once-flag should-not-use")
	code, msg := a.handleArgs(parts)
	if code != 0 {
		t.Fatalf("once commit via SSH_ORIGINAL_COMMAND failed: %s", msg)
	}
	if _, err := os.Stat(filepath.Join(target, "payload")); err != nil {
		t.Fatal("payload missing after once commit")
	}
}

func TestOnceMode_SSHOriginalCommandSnapshotExport(t *testing.T) {
	// C-03: ForcedCommand snapshot-export must stream binary tar.gz on stdout only (no status line).
	projectRoot := t.TempDir()
	proj := filepath.Join(projectRoot, "p1")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "project.godot"), []byte("config_version=5\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := testAgent(t, projectRoot)

	t.Setenv("SSH_ORIGINAL_COMMAND", "snapshot-export "+proj)
	parts := resolveOnceParts("ignored")

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	code, msg := a.handleArgs(parts)
	_ = w.Close()
	os.Stdout = old
	if code != 0 {
		t.Fatalf("snapshot-export once failed: %s", msg)
	}
	raw, err := io.ReadAll(r)
	_ = r.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
		t.Fatalf("expected gzip magic on stdout, got %d bytes", len(raw))
	}
	if bytes.Contains(raw, []byte("snapshot-export ok")) {
		t.Fatal("stdout must not contain status text (binary stream only)")
	}
}

func TestOnceMode_SSHOriginalCommandStageReceive(t *testing.T) {
	a := testAgent(t, t.TempDir())
	payload, sum := makeTarGz(t, map[string]string{"from-once.txt": "yes"})
	dest := filepath.Join(a.cfg.AllowedStaging, "staging-once-recv")

	t.Setenv("SSH_ORIGINAL_COMMAND", "stage-receive "+dest+" "+sum)
	parts := resolveOnceParts("ignored")

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
	code, msg := a.handleArgs(parts)
	os.Stdin = old
	if code != 0 {
		t.Fatalf("stage-receive once: %s", msg)
	}
	b, err := os.ReadFile(filepath.Join(dest, "from-once.txt"))
	if err != nil || string(b) != "yes" {
		t.Fatalf("content: %v %q", err, b)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func prepareStagingAndTarget(t *testing.T, a *Agent, projectRoot, stagingName, targetName, fileContent string) (staging, target string) {
	t.Helper()
	staging = filepath.Join(a.cfg.AllowedStaging, stagingName)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, fileContent), []byte(fileContent), 0o644); err != nil {
		t.Fatal(err)
	}
	target = filepath.Join(projectRoot, targetName)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	return staging, target
}
