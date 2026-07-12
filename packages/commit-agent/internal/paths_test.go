package internal

import (
	"path/filepath"
	"testing"
)

func TestValidateStagingSource(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "staging-job1")
	got, err := ValidateStagingSource(staging)
	if err != nil {
		t.Fatalf("expected ok: %v", err)
	}
	if got == "" {
		t.Fatal("empty path")
	}
}

func TestValidateTargetRejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	_, err := ValidateTarget("/etc/passwd", root)
	if err == nil {
		t.Fatal("expected rejection outside project root")
	}
}