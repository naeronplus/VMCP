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

func TestValidateStagingDest(t *testing.T) {
	root := t.TempDir()
	ok := filepath.Join(root, "staging-job1")
	if _, err := ValidateStagingDest(ok, root); err != nil {
		t.Fatalf("expected ok: %v", err)
	}
	if _, err := ValidateStagingDest(filepath.Join(root, "not-staging"), root); err == nil {
		t.Fatal("expected basename reject")
	}
	if _, err := ValidateStagingDest(filepath.Join(root, "..", "staging-x"), root); err == nil {
		t.Fatal("expected outside root reject")
	}
}