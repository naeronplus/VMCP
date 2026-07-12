package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadOptionalTLS_OffByDefault(t *testing.T) {
	t.Setenv("PGOS_PROVISION_TLS_CERT", "")
	t.Setenv("PGOS_PROVISION_TLS_KEY", "")
	t.Setenv("PGOS_PROVISION_TLS_CLIENT_CA", "")
	cfg, mode, err := loadOptionalTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cfg != nil || mode != "off" {
		t.Fatalf("want off, got cfg=%v mode=%s", cfg != nil, mode)
	}
}

func TestLoadOptionalTLS_RequiresBothServerPaths(t *testing.T) {
	t.Setenv("PGOS_PROVISION_TLS_CERT", "/tmp/only-cert.pem")
	t.Setenv("PGOS_PROVISION_TLS_KEY", "")
	_, _, err := loadOptionalTLS()
	if err == nil {
		t.Fatal("expected error when only cert set")
	}
}

func TestLoadOptionalTLS_ServerAndMTLS(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeSelfSigned(t, dir, "server")
	t.Setenv("PGOS_PROVISION_TLS_CERT", certPath)
	t.Setenv("PGOS_PROVISION_TLS_KEY", keyPath)
	t.Setenv("PGOS_PROVISION_TLS_CLIENT_CA", "")

	cfg, mode, err := loadOptionalTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cfg == nil || mode != "server" {
		t.Fatalf("want server TLS, mode=%s cfg=%v", mode, cfg != nil)
	}
	if len(cfg.Certificates) != 1 {
		t.Fatalf("certificates: %d", len(cfg.Certificates))
	}

	// mTLS with client CA = server cert (self-signed loop for unit test)
	t.Setenv("PGOS_PROVISION_TLS_CLIENT_CA", certPath)
	cfg2, mode2, err := loadOptionalTLS()
	if err != nil {
		t.Fatal(err)
	}
	if mode2 != "mtls" || cfg2.ClientAuth == 0 || cfg2.ClientCAs == nil {
		t.Fatalf("want mtls, mode=%s clientAuth=%v cas=%v", mode2, cfg2.ClientAuth, cfg2.ClientCAs != nil)
	}
}

func writeSelfSigned(t *testing.T, dir, name string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, name+".crt")
	keyPath = filepath.Join(dir, name+".key")
	cf, err := os.Create(certPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(cf, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		t.Fatal(err)
	}
	_ = cf.Close()
	kf, err := os.Create(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(kf, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}); err != nil {
		t.Fatal(err)
	}
	_ = kf.Close()
	return certPath, keyPath
}
