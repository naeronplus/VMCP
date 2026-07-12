package internal

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ValidateStagingSource ensures commit source is a staging-* directory under allowed roots.
func ValidateStagingSource(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	base := filepath.Base(abs)
	if !strings.HasPrefix(base, "staging-") && !strings.Contains(abs, string(filepath.Separator)+"staging-") {
		return "", fmt.Errorf("source must be subdirectory of staging-*")
	}
	if strings.Contains(abs, "..") {
		return "", fmt.Errorf("path traversal rejected")
	}
	return abs, nil
}

// ValidateStagingDest ensures stage-receive destination is under allowedStaging root
// and is a staging-* directory name (no path traversal).
func ValidateStagingDest(p, allowedStaging string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(allowedStaging)
	if err != nil {
		return "", err
	}
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("staging dest outside allowed staging root")
	}
	base := filepath.Base(abs)
	if !strings.HasPrefix(base, "staging-") {
		return "", fmt.Errorf("staging dest basename must start with staging-")
	}
	if strings.Contains(p, "..") {
		return "", fmt.Errorf("path traversal rejected")
	}
	return abs, nil
}

// ValidateTarget ensures target path stays within the configured project root.
func ValidateTarget(p, root string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("target outside allowed project root")
	}
	if strings.Contains(abs, "..") {
		return "", fmt.Errorf("path traversal rejected")
	}
	return abs, nil
}

// ValidateBackupPath allows restore from a previous target.bak-* sibling or under /tmp.
func ValidateBackupPath(p, projectRoot, allowedStaging string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if strings.Contains(p, "..") {
		return "", fmt.Errorf("path traversal rejected")
	}
	if _, err := ValidateTarget(abs, projectRoot); err == nil {
		return abs, nil
	}
	// sibling backup: <target>.bak-<jobId> lives next to target under project root parent
	rootAbs, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) || abs == rootAbs {
		return abs, nil
	}
	stageRoot, err := filepath.Abs(allowedStaging)
	if err != nil {
		return "", err
	}
	if abs == stageRoot || strings.HasPrefix(abs, stageRoot+string(filepath.Separator)) {
		return abs, nil
	}
	return "", fmt.Errorf("backup path outside allowed roots")
}
