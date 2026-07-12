# PGOS Commit Agent

Minimal privileged agent for **cross-machine atomic commits** (§4.2) under **SSH ForcedCommand**.

## ForcedCommand protocol (C-00)

Workers never use remote shell or `scp`. The JIT key uses:

```text
command="commit-agent-once",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,environment="PGOS_LOCK_KEY=…,PGOS_LOCK_OWNER=job:…,PGOS_JOB_ID=…,PGOS_REQUIRE_FENCING=true" ssh-ed25519 AAAA… pgos-ephemeral
```

### Verbs (`commit-agent -once` / `SSH_ORIGINAL_COMMAND`)

| Verb | STDIN | Args | Behavior |
|------|-------|------|----------|
| `stage-receive` | tar.gz | `<dest_dir> <sha256>` | Extract under `/tmp/staging-*`, verify checksum |
| `commit` | — | `<token> <source> <target> [lockKey lockOwner [nonce]]` | Fenced atomic rename; retains `target.bak-{jobId}` |
| `reimport` | — | `<project_path> <timeout_sec>` | Headless Godot reimport (`GODOT_BIN`, default `godot`) |
| `restore` | tar.gz **or** — | `<target_dir> [backup_path]` | Replace target from stdin archive or local backup |

Unknown verbs are rejected (no shell).

## Install

```bash
cd packages/commit-agent
go build -o /usr/local/bin/commit-agent ./cmd/agent
install -m 0755 bin/commit-agent-once /usr/local/bin/commit-agent-once
# wrapper:
#   #!/usr/bin/env bash
#   exec /usr/local/bin/commit-agent -once "${SSH_ORIGINAL_COMMAND:-$*}"
```

### Target host requirements

- Godot matching job `godotVersion` on `PATH` or `GODOT_BIN`
- Project root under `--project-root` (default `/var/godot/projects`)
- Provision endpoint must install keys with:
  - `singleUse: false`
  - `maxSessions: 8` (or similar)
  - `ttlSeconds: 300`
  - `environment` map → OpenSSH `environment="K=V,…"`
  - `forcedCommand: commit-agent-once`

## Security

| Control | Implementation |
|---------|----------------|
| No shell | Closed verb set only |
| Source path | `staging-*` under allowed staging root |
| Target path | Under configured `--project-root` |
| Fencing token | `POST /api/v1/locks/validate-token` |
| Lock identity | Process env (`environment=`) and/or commit args |
| Replay | Bloom filter + persistent nonce log |
| Crash recovery | `.pgos-pending-commit` sidecar |

## Run (systemd socket mode)

```ini
[Service]
Environment=PGOS_REQUIRE_FENCING=true
ExecStart=/usr/local/bin/commit-agent \
  -socket /var/run/pgos-commit-agent.sock \
  -project-root /var/godot/projects \
  -pgos-url https://pgos.example.com \
  -auth-token ${PGOS_AGENT_TOKEN}
```

Socket JSON protocol remains supported for local agent mode (`commit` only via JSON line).

## Backup lifecycle (post-commit)

On successful `commit`, previous target is moved to `target.bak-{jobId}` and **retained** so post-commit verify can `restore` if S3 snapshot is unavailable. Next commit for the same job id replaces that backup.
