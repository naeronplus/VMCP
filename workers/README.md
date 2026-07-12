# PGOS Workers — GitHub Actions & Tier A Runners

## Overview

Workers execute Godot generation jobs dispatched by the orchestrator via `workflow_dispatch`. **Sensitive credentials never appear in workflow inputs** — only `secretJwe` is passed; callback tokens are embedded inside the JWE.

## Required GitHub Actions secrets

| Secret | Purpose |
|--------|---------|
| `PGOS_BASE_URL` | Orchestrator public URL (e.g. `https://pgos.example.com`) |
| `PGOS_ADMIN_TOKEN` | Admin JWT for `godot_health.yml` cron probes |
| `SLACK_WEBHOOK_URL` | Optional alert webhook for health failures |

## Tier B (GitHub-hosted)

Uses `ubuntu-latest`. No extra setup — workflows install Godot via `setup-godot.sh`.

## Tier A (self-hosted `godot-worker`)

1. Register a self-hosted runner with labels: `self-hosted`, `godot-worker`
2. Install Godot 4.3+ and export templates (or let `setup-godot.sh` handle it)
3. Create project directory root: `/var/godot/projects/` (writable by runner user)
4. For cross-machine commits, install `commit-agent` **on target hosts** (not only the runner):

```bash
cd packages/commit-agent
go build -o /usr/local/bin/commit-agent ./cmd/agent
install -m 0755 bin/commit-agent-once /usr/local/bin/commit-agent-once
```

Target host env / systemd:

- `PGOS_AGENT_TOKEN` — token allowed to call `POST /locks/validate-token`
- `PGOS_REQUIRE_FENCING=true`
- `PGOS_URL` / `-pgos-url` — orchestrator base URL
- `GODOT_BIN` — optional absolute path to Godot (must match job version)

## Worker pipeline

Heartbeat runs for the **entire** generation → commit → post-commit window inside one GHA step (`Execute job pipeline`, C-01). Interval default **15s**; orchestrator stale threshold `HEARTBEAT_STALE_AFTER_MS` (default 30000).

1. `resolve-secrets.sh` — POST `/api/v1/resolve-secret` with dispatch JWE  
2. `setup-godot.sh` — install Godot + export templates  
3. `verify-godot.sh` — **exact** semver match (not substring) + export template presence (`E006`)  
4. **Single step** with `pgos-lifecycle.sh` heartbeat:  
   - `run-generation.sh`  
   - `atomic-commit.sh`  
   - `post-commit-verify.sh`

## Cross-machine transport (C-00)

JIT SSH keys use **ForcedCommand=`commit-agent-once`**. Do **not** use `scp` or remote shell.

| Step | Verb |
|------|------|
| Stage | `stage-receive <remote_tmp> <sha256>` (tar.gz on stdin) |
| Commit | `commit <token> <source> <target> [lockKey lockOwner nonce]` |
| Verify | `reimport <target> <timeout>` |
| Rollback | `restore <target>` (stdin tar) or `restore <target> <backup>` |

Helpers: `workers/scripts/lib/pgos-remote.sh` (`pgos_ssh_agent`, `pgos_ssh_agent_stdin`, `pgos_cleanup_ssh_key`).

### Provisioning contract

Orchestrator posts to `metadata.targetProvisionUrl` with:

- `singleUse: false`, `maxSessions: 8`, `ttlSeconds: 300`
- `forcedCommand: "commit-agent-once"`
- `environment: { PGOS_LOCK_KEY, PGOS_LOCK_OWNER, PGOS_JOB_ID, PGOS_REQUIRE_FENCING: "true" }`

Target must write OpenSSH `environment="…"` on the key line (AcceptEnv not required).

Job metadata **must** include both `targetHost` and `targetProvisionUrl` or dispatch ends in **`DISPATCH_FAILED`** (no SSH PEM in JWE).

### Remote verify / rollback

- Cross-machine reimport runs **on the target host** (default on).  
- Break-glass only: `PGOS_REMOTE_VERIFY=0` (unsafe — validates runner FS).  
- Rollback: S3 snapshot archive via `restore` stdin, else `target.bak-{jobId}` on host.

### Ephemeral SSH key cleanup (H-11)

Cross-machine jobs receive a short-lived ed25519 private key in the JWE envelope.

| Stage | Behavior |
|-------|----------|
| `resolve-secrets.sh` | Writes `/tmp/pgos-ssh-key-${JOB_ID}` mode `600`; **never** puts PEM in `GITHUB_ENV` or logs |
| `pgos_ssh_opts` | Uses key file; registers `EXIT`/`ERR`/`INT`/`TERM` cleanup trap |
| `atomic-commit.sh` | On **failure**, secure-deletes key; on **successful** cross-machine commit, sets `PGOS_SSH_KEEP_KEY=1` so post-commit can reimport/restore |
| `post-commit-verify.sh` | Always secure-deletes key on exit (success or failure) |
| Pipeline `pgos_heartbeat_trap` | Final safety-net cleanup at end of the long GHA step |

Secure delete: `shred -u -z` when available, else zero-fill + `rm`. Clears in-process `SSH_PRIVATE_KEY_PEM`. Known_hosts file `/tmp/pgos_known_hosts_${JOB_ID}` removed.

```bash
bash workers/tests/ssh-key-cleanup-smoke.sh
```

**DoD:** `/tmp/pgos-ssh-key-*` for the job is absent after the pipeline finishes or fails.

## Scripts

| Script | Role |
|--------|------|
| `heartbeat.sh` | PATCH `/jobs/:id/heartbeat` every `HEARTBEAT_INTERVAL` (15s) |
| `lib/pgos-lifecycle.sh` | Start/stop heartbeat + EXIT trap (same step only) |
| `lib/pgos-remote.sh` | ForcedCommand SSH verb helpers |
| `lib/pgos-s3.sh` | Presigned upload/download |
| `atomic-commit.sh` | S3 snapshot (same-machine) + fenced commit |
| `post-commit-verify.sh` | Reimport + rollback |
| `run-generation.sh` | Stage, reimport, validate |
| `setup-godot.sh` | Install Godot + templates (+ version.txt, cache mirror) |
| `verify-godot.sh` | Exact semver + export templates pre-generation (E006); uses `lib/godot-semver.mjs` |
| `resolve-secrets.sh` | JWE → env |
| `uid-reconcile.sh` | Host-side UID rewrite + Godot reimport when project tree is not on orchestrator |

### E006 version / template checks (H-09 / H-10)

`verify-godot.sh` replaces naive `grep -F` matching so **`4.3.1` does not match `4.3.10`**.

- Parses `godot --version` first line via Node exact semver equality (`lib/godot-semver.mjs`, aligned with `@vibrato/shared` `versionsEqual`).
- Requires export templates under `~/.local/share/godot/export_templates/{version}.stable/` (or `.godot-cache` mirror), non-empty, with `version.txt` match when present.
- On failure: PATCH job `VALIDATION_FAILED` + **E006** with detail distinguishing **version** vs **templates**.

```bash
# Local unit tests (no Godot binary required)
node --test workers/tests/godot-semver.test.mjs
```

## Cross-machine E2E checklist (P0 gate)

Record evidence on the remediation PR:

1. **Happy path:** job with `commitStrategy=cross-machine`, `metadata.targetHost`, `metadata.targetProvisionUrl` → COMPLETED; confirm agent logs `stage-receive` / `commit` / `reimport`.
2. **Provision fail:** break provision URL → job `DISPATCH_FAILED`, no workflow SSH material.
3. **Reimport fail:** force Godot error on target → remote `restore` + `ROLLBACK` + E002.
4. **Heartbeat:** long commit/verify without E005; killing heartbeat leads to E005 only after stale window.
5. **Fencing:** wrong `PGOS_LOCK_OWNER` → commit rejected.

Local smoke tests:

```bash
bash workers/tests/heartbeat-lifecycle-smoke.sh
bash workers/tests/pgos-remote-protocol-smoke.sh
bash workers/tests/pgos-s3-smoke.sh
```

## Local script testing

```bash
export PGOS_BASE_URL=http://localhost:8080
export JOB_ID=<uuid>
export PROJECT_ID=<uuid>
export SECRET_JWE=<dispatch-jwe-from-job>
bash workers/scripts/resolve-secrets.sh
```
