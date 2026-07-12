package internal

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode"
)

// ValidateEd25519OpenSSH checks OpenSSH wire format:
//
//	ssh-ed25519 <base64-blob> [comment]
//
// The base64 blob must decode to: uint32 len("ssh-ed25519") + type + uint32(32) + 32-byte key.
func ValidateEd25519OpenSSH(pub string) error {
	pub = strings.TrimSpace(pub)
	if pub == "" {
		return fmt.Errorf("publicKey is required")
	}
	fields := strings.Fields(pub)
	if len(fields) < 2 {
		return fmt.Errorf("publicKey must be: ssh-ed25519 <base64> [comment]")
	}
	if fields[0] != "ssh-ed25519" {
		return fmt.Errorf("only ssh-ed25519 public keys are accepted")
	}
	raw, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil {
		return fmt.Errorf("publicKey base64 invalid: %w", err)
	}
	// Minimum: 4 + 11 ("ssh-ed25519") + 4 + 32 = 51
	if len(raw) < 51 {
		return fmt.Errorf("publicKey blob too short")
	}
	typeLen := int(raw[0])<<24 | int(raw[1])<<16 | int(raw[2])<<8 | int(raw[3])
	if typeLen != 11 || string(raw[4:4+typeLen]) != "ssh-ed25519" {
		return fmt.Errorf("publicKey blob type is not ssh-ed25519")
	}
	off := 4 + typeLen
	if off+4 > len(raw) {
		return fmt.Errorf("publicKey blob truncated at key length")
	}
	keyLen := int(raw[off])<<24 | int(raw[off+1])<<16 | int(raw[off+2])<<8 | int(raw[off+3])
	if keyLen != 32 {
		return fmt.Errorf("ed25519 key length must be 32, got %d", keyLen)
	}
	if off+4+keyLen > len(raw) {
		return fmt.Errorf("publicKey blob truncated at key material")
	}
	return nil
}

// RenderAuthorizedKeysLine builds the normative ForcedCommand authorized_keys line.
//
//	command="…",no-port-forwarding,…,environment="K=V,…" ssh-ed25519 AAAA… comment
func RenderAuthorizedKeysLine(forcedCommand, publicKey string, environment map[string]string) (string, error) {
	forcedCommand = strings.TrimSpace(forcedCommand)
	if forcedCommand == "" {
		return "", fmt.Errorf("forcedCommand is required")
	}
	if strings.ContainsAny(forcedCommand, "\"\n\r") {
		return "", fmt.Errorf("forcedCommand contains illegal characters")
	}
	if err := ValidateEd25519OpenSSH(publicKey); err != nil {
		return "", err
	}

	envPart, err := renderEnvironment(environment)
	if err != nil {
		return "", err
	}

	opts := []string{
		fmt.Sprintf(`command="%s"`, forcedCommand),
		"no-port-forwarding",
		"no-X11-forwarding",
		"no-agent-forwarding",
		"no-pty",
	}
	if envPart != "" {
		opts = append(opts, envPart)
	}
	return strings.Join(opts, ",") + " " + strings.TrimSpace(publicKey), nil
}

func renderEnvironment(environment map[string]string) (string, error) {
	if len(environment) == 0 {
		return "", nil
	}
	// Stable order for golden tests: sort keys
	keys := make([]string, 0, len(environment))
	for k := range environment {
		keys = append(keys, k)
	}
	// simple insertion sort (small maps)
	for i := 1; i < len(keys); i++ {
		j := i
		for j > 0 && keys[j-1] > keys[j] {
			keys[j-1], keys[j] = keys[j], keys[j-1]
			j--
		}
	}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := environment[k]
		if err := validateEnvToken(k); err != nil {
			return "", fmt.Errorf("environment key %q: %w", k, err)
		}
		if err := validateEnvValue(v); err != nil {
			return "", fmt.Errorf("environment %s: %w", k, err)
		}
		parts = append(parts, k+"="+v)
	}
	return `environment="` + strings.Join(parts, ",") + `"`, nil
}

func validateEnvToken(s string) error {
	if s == "" {
		return fmt.Errorf("empty")
	}
	for _, r := range s {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			return fmt.Errorf("invalid character %q", r)
		}
	}
	return nil
}

func validateEnvValue(s string) error {
	// OpenSSH environment= values inside quotes: reject quotes, commas, newlines
	if strings.ContainsAny(s, "\",\n\r") {
		return fmt.Errorf("value contains illegal characters")
	}
	return nil
}

// SafeFileComponent strips path separators for jobId/keyId filename fragments.
func SafeFileComponent(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	out := b.String()
	if out == "" {
		return "x"
	}
	if len(out) > 64 {
		return out[:64]
	}
	return out
}
