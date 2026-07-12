// PGOS target JIT SSH provisioner (DEP-01).
// Co-located on each Godot target host — not inside Railway orchestrator.
//
//	POST /v1/provision  — install TTL-bound authorized_keys fragment
//	POST /v1/revoke     — early purge by jobId+keyId
//	GET  /health        — liveness
//
// Optional TLS / mTLS (SEC-01):
//
//	PGOS_PROVISION_TLS_CERT + PGOS_PROVISION_TLS_KEY — serve HTTPS
//	PGOS_PROVISION_TLS_CLIENT_CA — require client certs (mutual TLS)
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/vibrato/pgos/target-provisioner/internal"
)

func main() {
	token := os.Getenv("PGOS_PROVISION_TOKEN")
	if token == "" {
		log.Fatal("PGOS_PROVISION_TOKEN is required")
	}
	keysDir := envOr("AUTHORIZED_KEYS_DIR", "/etc/ssh/pgos-authorized-keys.d")
	ledgerPath := envOr("PGOS_KEYS_LEDGER", "/var/lib/pgos/keys-ledger.json")
	listen := envOr("PGOS_PROVISION_LISTEN", "127.0.0.1:9071")
	maxConcurrent := 256
	if v := os.Getenv("PGOS_MAX_CONCURRENT_KEYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxConcurrent = n
		}
	}

	srv := internal.NewServer(internal.Config{
		Token:             token,
		AuthorizedKeysDir: keysDir,
		LedgerPath:        ledgerPath,
		MaxConcurrentKeys: maxConcurrent,
		Logger:            log.Default(),
	})

	stopSweep := make(chan struct{})
	go srv.StartSweeper(60*time.Second, stopSweep)

	httpSrv := &http.Server{
		Addr:              listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	tlsCfg, tlsMode, err := loadOptionalTLS()
	if err != nil {
		log.Fatalf("TLS config: %v", err)
	}
	if tlsCfg != nil {
		httpSrv.TLSConfig = tlsCfg
	}

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("listen %s: %v", listen, err)
	}
	log.Printf("pgos-target-provisioner listening on %s keysDir=%s ledger=%s tls=%s", listen, keysDir, ledgerPath, tlsMode)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		close(stopSweep)
		shctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shctx)
	}()

	if tlsCfg != nil {
		// Certificates already in TLSConfig; empty files use Config.
		if err := httpSrv.ServeTLS(ln, "", ""); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve tls: %v", err)
		}
	} else {
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}
}

// loadOptionalTLS builds TLS config when server cert+key env paths are set (SEC-01).
// Client CA enables mutual TLS (RequireAndVerifyClientCert).
func loadOptionalTLS() (*tls.Config, string, error) {
	certFile := os.Getenv("PGOS_PROVISION_TLS_CERT")
	keyFile := os.Getenv("PGOS_PROVISION_TLS_KEY")
	clientCA := os.Getenv("PGOS_PROVISION_TLS_CLIENT_CA")
	if certFile == "" && keyFile == "" {
		if clientCA != "" {
			return nil, "off", nil // client CA alone is ignored without server TLS
		}
		return nil, "off", nil
	}
	if certFile == "" || keyFile == "" {
		return nil, "", errTLSPair
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, "", err
	}
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cert},
	}
	mode := "server"
	if clientCA != "" {
		pem, err := os.ReadFile(clientCA)
		if err != nil {
			return nil, "", err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, "", errClientCA
		}
		cfg.ClientCAs = pool
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
		mode = "mtls"
	}
	return cfg, mode, nil
}

var (
	errTLSPair  = errString("PGOS_PROVISION_TLS_CERT and PGOS_PROVISION_TLS_KEY must both be set")
	errClientCA = errString("PGOS_PROVISION_TLS_CLIENT_CA did not contain a valid PEM certificate")
)

type errString string

func (e errString) Error() string { return string(e) }

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
