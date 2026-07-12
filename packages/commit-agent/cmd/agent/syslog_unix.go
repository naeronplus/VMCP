//go:build !windows

package main

import (
	"io"
	"log/syslog"
)

func trySyslog() (io.Writer, error) {
	return syslog.New(syslog.LOG_INFO|syslog.LOG_DAEMON, "pgos-commit-agent")
}
