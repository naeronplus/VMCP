package internal

import (
	"encoding/base64"
	"strings"
	"testing"
)

// validOpenSSHEd25519 builds a syntactically valid OpenSSH ed25519 line for tests.
func validOpenSSHEd25519(t *testing.T) string {
	t.Helper()
	// wire: string "ssh-ed25519" + string 32-byte key
	typeStr := []byte("ssh-ed25519")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	blob := make([]byte, 0, 4+len(typeStr)+4+len(key))
	blob = appendU32(blob, uint32(len(typeStr)))
	blob = append(blob, typeStr...)
	blob = appendU32(blob, uint32(len(key)))
	blob = append(blob, key...)
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob) + " pgos-ephemeral"
}

func appendU32(b []byte, n uint32) []byte {
	return append(b, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}

func TestValidateEd25519OpenSSH(t *testing.T) {
	ok := validOpenSSHEd25519(t)
	if err := ValidateEd25519OpenSSH(ok); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	if err := ValidateEd25519OpenSSH(""); err == nil {
		t.Fatal("empty accepted")
	}
	if err := ValidateEd25519OpenSSH("ssh-rsa AAAA"); err == nil {
		t.Fatal("rsa accepted")
	}
	if err := ValidateEd25519OpenSSH("ssh-ed25519 !!!"); err == nil {
		t.Fatal("bad base64 accepted")
	}
}

func TestRenderAuthorizedKeysLine_Golden(t *testing.T) {
	pub := validOpenSSHEd25519(t)
	line, err := RenderAuthorizedKeysLine("commit-agent-once", pub, map[string]string{
		"PGOS_JOB_ID":          "uuid-1",
		"PGOS_LOCK_KEY":        "gen:p1",
		"PGOS_LOCK_OWNER":      "job:uuid-1",
		"PGOS_REQUIRE_FENCING": "true",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Normative option prefixes
	wantPrefix := `command="commit-agent-once",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,environment="`
	if !strings.HasPrefix(line, wantPrefix) {
		t.Fatalf("prefix mismatch:\n%s", line)
	}
	if !strings.Contains(line, "PGOS_LOCK_KEY=gen:p1") {
		t.Fatalf("missing env: %s", line)
	}
	if !strings.Contains(line, "PGOS_REQUIRE_FENCING=true") {
		t.Fatalf("missing fencing env: %s", line)
	}
	if !strings.HasSuffix(strings.TrimSpace(line), "pgos-ephemeral") && !strings.Contains(line, " pgos-ephemeral") {
		t.Fatalf("missing pubkey comment: %s", line)
	}
	// Full line ends with pubkey
	if !strings.Contains(line, "ssh-ed25519 ") {
		t.Fatalf("missing key type: %s", line)
	}
}

func TestSafeFileComponent(t *testing.T) {
	if SafeFileComponent("../etc/passwd") != "___etc_passwd" && !strings.Contains(SafeFileComponent("a/b"), "_") {
		t.Fatalf("unexpected: %s", SafeFileComponent("../etc/passwd"))
	}
}
