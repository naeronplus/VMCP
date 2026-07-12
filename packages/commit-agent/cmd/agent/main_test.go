package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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

	// Recovery scan reads sidecar JSON
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

	// Successful commit removes sidecar
	if err := os.Remove(sidecarPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(sidecarPath); !os.IsNotExist(err) {
		t.Fatal("sidecar should be removed after successful commit")
	}
}