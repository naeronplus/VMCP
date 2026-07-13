# PGOS Target Provisioner (DEP-01)

Small HTTP service **co-located on each Godot target host**. Installs TTL-bound OpenSSH `authorized_keys` fragments so the orchestrator can JIT-provision ephemeral ed25519 keys for cross-machine ForcedCommand commits.

**Not** deployed inside the Railway orchestrator container.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/v1/provision` | `Authorization: Bearer $PGOS_PROVISION_TOKEN` | Install key |
| `POST` | `/v1/revoke` | Bearer | Early purge `{ jobId, keyId }` |
| `GET` | `/health` | none | Liveness |

### `POST /v1/provision`

Request (matches orchestrator `ssh-provision.ts`):

```json
{
  "publicKey": "ssh-ed25519 AAAA… pgos-ephemeral",
  "forcedCommand": "commit-agent-once",
  "jobId": "uuid",
  "singleUse": false,
  "maxSessions": 8,
  "ttlSeconds": 300,
  "environment": {
    "PGOS_LOCK_KEY": "…",
    "PGOS_LOCK_OWNER": "job:uuid",
    "PGOS_JOB_ID": "uuid",
    "PGOS_REQUIRE_FENCING": "true"
  }
}
```

**201** `{ "ok": true, "keyId": "…", "expiresAt": "ISO8601" }`

| Status | When |
|--------|------|
| 400 | Validation (missing publicKey, bad TTL, malformed ed25519) |
| 401 | Missing/wrong bearer |
| 409 | Max concurrent keys (global or per-job vs `maxSessions`) |
| 500 | Write failure |

### authorized_keys line (normative)

```text
command="commit-agent-once",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,environment="PGOS_JOB_ID=…,PGOS_LOCK_KEY=…,PGOS_LOCK_OWNER=job:…,PGOS_REQUIRE_FENCING=true" ssh-ed25519 AAAA… pgos-ephemeral
```

Files: `$AUTHORIZED_KEYS_DIR/pgos-{jobId}-{keyId}.pub` mode `0600`.

## Install (DEP-04)

### One-command (preferred)

```bash
# From monorepo root on the target host (requires Go, or SKIP_BUILD=1 + prebuilt binary)
sudo bash packages/target-provisioner/scripts/install.sh

# Build + install systemd unit + start:
sudo INSTALL_SYSTEMD=1 bash packages/target-provisioner/scripts/install.sh

# From CI artifact (no Go on target):
# Download Actions artifact target-provisioner-linux-amd64 → packages/target-provisioner/bin/pgos-target-provisioner
sudo SKIP_BUILD=1 bash packages/target-provisioner/scripts/install.sh
```

`install.sh` installs the binary (default `/usr/local/bin/pgos-target-provisioner`), creates `/etc/ssh/pgos-authorized-keys.d`, `/var/lib/pgos`, and a template `/etc/pgos/target-provisioner.env`.

### Manual

```bash
cd packages/target-provisioner
go build -o /usr/local/bin/pgos-target-provisioner ./cmd/provisioner
install -m 0644 systemd/pgos-target-provisioner.service /etc/systemd/system/
mkdir -p /etc/ssh/pgos-authorized-keys.d /var/lib/pgos
# Set PGOS_PROVISION_TOKEN in /etc/pgos/target-provisioner.env (same value as orchestrator)
systemctl daemon-reload
systemctl enable --now pgos-target-provisioner
```

### CI artifact

GitHub Actions (`ci.yml` → job `commit-agent`) builds and uploads **`target-provisioner-linux-amd64`** after `go test` (DEP-04), next to `commit-agent-linux-amd64` (DEP-02).

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PGOS_PROVISION_TOKEN` | **required** | Bearer shared with orchestrator (SEC-02) |
| `AUTHORIZED_KEYS_DIR` | `/etc/ssh/pgos-authorized-keys.d` | Fragment directory |
| `PGOS_KEYS_LEDGER` | `/var/lib/pgos/keys-ledger.json` | Append-only JSON ledger |
| `PGOS_PROVISION_LISTEN` | `127.0.0.1:9071` | Bind address |
| `PGOS_MAX_CONCURRENT_KEYS` | `256` | Global active-key ceiling |
| `PGOS_PROVISION_TLS_CERT` | empty | Server TLS cert PEM (SEC-01) |
| `PGOS_PROVISION_TLS_KEY` | empty | Server TLS key PEM (SEC-01; required with CERT) |
| `PGOS_PROVISION_TLS_CLIENT_CA` | empty | Client CA PEM — enables **mTLS** (RequireAndVerifyClientCert) |

TTL sweeper runs every **60s** and deletes expired key files + ledger rows.

### Production TLS / mTLS (SEC-01)

1. Generate server + client certs under a private CA (or use your mesh).
2. On **target**: set `PGOS_PROVISION_TLS_CERT`, `PGOS_PROVISION_TLS_KEY`, `PGOS_PROVISION_TLS_CLIENT_CA` (CA that signed orchestrator client certs).
3. On **orchestrator**: set `PGOS_PROVISION_MTLS_CERT`, `PGOS_PROVISION_MTLS_KEY`, optional `PGOS_PROVISION_MTLS_CA`.
4. Point `metadata.targetProvisionUrl` at `https://…/v1/provision`.
5. Keep `PGOS_PROVISION_TOKEN` as a second factor (SEC-02); do not share the sandbox token.

## sshd configuration

Include the fragment directory so JIT keys are accepted **in addition to** user `authorized_keys`:

```sshd
# /etc/ssh/sshd_config.d/pgos-authorized-keys.conf
AuthorizedKeysFile .ssh/authorized_keys /etc/ssh/pgos-authorized-keys.d/%u
# Or aggregate all fragments via AuthorizedKeysCommand (site-specific).
# Ensure: PermitUserEnvironment yes  (or use environment= in authorized_keys — OpenSSH 7.6+)
# AcceptEnv is not a substitute for authorized_keys environment=.
```

Reload: `systemctl reload sshd`.

**Security:** Prefer **in-process mTLS** (env above) or listen on `127.0.0.1` and terminate TLS/mTLS on a reverse proxy / private VPN. Production checklist: **mTLS over bearer-only** for provision (SEC-01); dedicated `PGOS_PROVISION_TOKEN` (SEC-02).

## Orchestrator wiring

On the **orchestrator** service (Railway):

```text
PGOS_PROVISION_TOKEN=<same as target>
```

Project / job metadata:

```json
{
  "targetHost": "godot@target.internal",
  "targetProvisionUrl": "https://target.internal:9071/v1/provision"
}
```

Local/dev example:

```text
metadata.targetProvisionUrl=http://127.0.0.1:9071/v1/provision
```

Do **not** reuse `SANDBOX_INTERNAL_TOKEN` long-term (orchestrator falls back with a deprecation warning only).

## Manual smoke

```bash
export PGOS_PROVISION_TOKEN=dev-provision-token
# generate a real ed25519 pubkey, then:
curl -sS -X POST http://127.0.0.1:9071/v1/provision \
  -H "Authorization: Bearer $PGOS_PROVISION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"ssh-ed25519 AAAA… pgos-ephemeral","jobId":"smoke","ttlSeconds":300,"maxSessions":8,"singleUse":false,"forcedCommand":"commit-agent-once","environment":{"PGOS_REQUIRE_FENCING":"true"}}'
# Expect 201; ls /etc/ssh/pgos-authorized-keys.d/
# ssh -i ephemeral_key godot@target  → ForcedCommand commit-agent-once
```

## Tests

```bash
cd packages/target-provisioner
go test ./...
```

## Related

- Orchestrator client: `packages/orchestrator/src/services/ssh-provision.ts`
- Commit agent ForcedCommand verbs: `packages/commit-agent`
- Worker cross-machine docs: `workers/README.md`
