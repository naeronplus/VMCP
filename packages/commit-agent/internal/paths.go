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