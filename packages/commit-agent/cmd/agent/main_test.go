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

// CM-LOCK-01: stat-lock reports locked|unlocked for project.godot.lock on target FS.
func TestStatLock_UnlockedWhenMissing(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	proj := filepath.Join(root, "game")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	code, msg := a.handleArgs([]string{"stat-lock", proj})
	if code != 0 {
		t.Fatalf("code=%d msg=%s", code, msg)
	}
	if msg != "unlocked" {
		t.Fatalf("want unlocked, got %q", msg)
	}
}

func TestStatLock_LockedWhenPresent(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	proj := filepath.Join(root, "game")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(proj, "project.godot.lock")
	if err := os.WriteFile(lock, []byte("editor"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, msg := a.handleArgs([]string{"stat-lock", proj})
	if code != 0 {
		t.Fatalf("code=%d msg=%s", code, msg)
	}
	if msg != "locked" {
		t.Fatalf("want locked, got %q", msg)
	}
}

func TestStatLock_TraversalRejected(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"stat-lock", filepath.Join(a.cfg.ProjectRoot, "..", "etc")})
	if code == 0 {
		t.Fatal("expected traversal reject")
	}
	if msg == "locked" || msg == "unlocked" {
		t.Fatalf("must not report lock status for escaped path: %s", msg)
	}
}

func TestStatLock_Usage(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"stat-lock"})
	if code == 0 || !strings.Contains(msg, "usage: stat-lock") {
		t.Fatalf("usage: code=%d msg=%s", code, msg)
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

func TestSnapshotExport_HappyPathStableChecksum(t *testing.T) {
	root := t.TempDir()
	proj := filepath.Join(root, "projects", "p1")
	if err := os.MkdirAll(filepath.Join(proj, "scenes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "project.godot"), []byte("config_version=5\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "scenes", "main.tscn"), []byte("[gd_scene]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// .godot cache must be excluded
	if err := os.MkdirAll(filepath.Join(proj, ".godot", "imported"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, ".godot", "imported", "x"), []byte("cache"), 0o644); err != nil {
		t.Fatal(err)
	}

	a := testAgent(t, filepath.Join(root, "projects"))
	sum1 := runSnapshotExport(t, a, proj)
	sum2 := runSnapshotExport(t, a, proj)
	if sum1 != sum2 {
		t.Fatalf("checksum not stable: %s vs %s", sum1, sum2)
	}
	// Archive must not contain .godot/ cache path entries (exclusion list).
	// Note: "project.godot" is a valid filename — only path segments named ".godot" are excluded.
	names := listTarGzNames(t, lastSnapshotBytes)
	if len(names) == 0 {
		t.Fatal("expected archive entries")
	}
	var sawProject, sawScene bool
	for _, n := range names {
		for _, seg := range strings.Split(n, "/") {
			if seg == ".godot" {
				t.Fatalf("archive includes .godot path segment: %v", names)
			}
		}
		if n == "project.godot" {
			sawProject = true
		}
		if n == "scenes/main.tscn" || strings.HasSuffix(n, "/main.tscn") {
			sawScene = true
		}
	}
	if !sawProject || !sawScene {
		t.Fatalf("expected project.godot + main.tscn in archive, got %v", names)
	}
}

func TestSnapshotExport_MissingPath(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	code, msg := a.handleArgs([]string{"snapshot-export", filepath.Join(root, "does-not-exist")})
	if code == 0 {
		t.Fatal("expected fail for missing path")
	}
	if !strings.Contains(msg, "missing") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestSnapshotExport_TraversalRejected(t *testing.T) {
	a := testAgent(t, t.TempDir())
	code, msg := a.handleArgs([]string{"snapshot-export", filepath.Join(a.cfg.ProjectRoot, "..", "etc")})
	if code == 0 {
		t.Fatal("expected traversal reject")
	}
	if !strings.Contains(msg, "outside") && !strings.Contains(msg, "traversal") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestSnapshotExport_UsageAndNotDirectory(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	code, msg := a.handleArgs([]string{"snapshot-export"})
	if code == 0 || !strings.Contains(msg, "usage: snapshot-export") {
		t.Fatalf("usage: code=%d msg=%s", code, msg)
	}
	filePath := filepath.Join(root, "not-a-dir")
	if err := os.WriteFile(filePath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, msg = a.handleArgs([]string{"snapshot-export", filePath})
	if code == 0 {
		t.Fatal("expected fail for non-directory")
	}
	if !strings.Contains(msg, "not a directory") {
		t.Fatalf("msg=%s", msg)
	}
}

func TestSnapshotExport_RestoreRoundTrip(t *testing.T) {
	// C-03 primary path: snapshot-export stdout archive must be restorable via restore stdin.
	root := t.TempDir()
	proj := filepath.Join(root, "live")
	if err := os.MkdirAll(filepath.Join(proj, "scenes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "project.godot"), []byte("config_version=5\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "scenes", "main.tscn"), []byte("[gd_scene load_steps=1]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := testAgent(t, root)
	_ = runSnapshotExport(t, a, proj)
	archive := lastSnapshotBytes
	if len(archive) < 2 || archive[0] != 0x1f || archive[1] != 0x8b {
		t.Fatalf("expected gzip magic, got %d bytes", len(archive))
	}

	// Mutate live tree, then restore from archive
	if err := os.WriteFile(filepath.Join(proj, "project.godot"), []byte("corrupted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "evil.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	oldIn := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = r
	go func() {
		_, _ = w.Write(archive)
		_ = w.Close()
	}()
	code, msg := a.handleArgs([]string{"restore", proj})
	os.Stdin = oldIn
	_ = r.Close()
	if code != 0 {
		t.Fatalf("restore failed: %s", msg)
	}
	body, err := os.ReadFile(filepath.Join(proj, "project.godot"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "config_version=5\n" {
		t.Fatalf("project.godot not restored: %q", body)
	}
	if _, err := os.Stat(filepath.Join(proj, "evil.txt")); !os.IsNotExist(err) {
		t.Fatal("restore should replace tree (evil.txt should be gone)")
	}
	scene, err := os.ReadFile(filepath.Join(proj, "scenes", "main.tscn"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(scene), "gd_scene") {
		t.Fatalf("scene not restored: %q", scene)
	}
}

var lastSnapshotBytes []byte

func runSnapshotExport(t *testing.T, a *Agent, projectPath string) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	code, msg := a.handleArgs([]string{"snapshot-export", projectPath})
	_ = w.Close()
	os.Stdout = old
	if code != 0 {
		t.Fatalf("snapshot-export failed: %s", msg)
	}
	raw, err := io.ReadAll(r)
	_ = r.Close()
	if err != nil {
		t.Fatal(err)
	}
	lastSnapshotBytes = raw
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func listTarGzNames(t *testing.T, raw []byte) []string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var names []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, hdr.Name)
	}
	return names
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
