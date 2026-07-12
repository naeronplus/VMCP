# PGOS Commit Agent

Minimal privileged agent for **cross-machine atomic commits** (§4.2).

## Command surface

Only one command is accepted (Unix socket or SSH forced command):

```text
commit <fencingToken> <source_temp_dir> <target_dir>
```

## Security

| Control | Implementation |
|---------|----------------|
| No shell | Argument parsing only — never `exec` of user strings via shell |
| Source path | Must be under `staging-*` temp directory |
| Target path | Must be under configured `--project-root` |
| Fencing token | Validated against PGOS `POST /api/v1/locks/validate-token` (Postgres ledger) |
| Replay | In-memory bloom filter + persistent nonce log |
| Ephemeral SSH | JIT ed25519 keys provisioned by PGOS; single-login `authorized_keys` |
| Crash recovery | On restart, pending `.pgos-pending-commit` sidecars re-execute rename if token still valid |

## Build

```bash
cd packages/commit-agent
go build -o bin/commit-agent ./cmd/agent
```

## Run (systemd)

```ini
[Service]
ExecStart=/usr/local/bin/commit-agent \
  -socket /var/run/pgos-commit-agent.sock \
  -project-root /var/godot/projects \
  -pgos-url https://pgos.example.com \
  -auth-token ${PGOS_AGENT_TOKEN}
```

## Docker

```bash
docker run --network=host -v /var/godot/projects:/var/godot/projects \
  pgos/commit-agent:latest
```

## Secret rotation

PGOS Railway cron every 90 days calls the target's `/rotate-secrets` endpoint (mutual TLS) to rotate agent certificates.
