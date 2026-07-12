//go:build windows

package main

import (
	"fmt"
	"io"
)

func trySyslog() (io.Writer, error) {
	return nil, fmt.Errorf("syslog not available on windows")
}
