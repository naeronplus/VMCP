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
| `snapshot-export` | — | `<project_path>` | Stream **tar.gz of live project tree to stdout** (C-03 primary S3 rollback). Excludes `.godot/`. Missing path → exit 1. Status only on stderr (binary stdout). |
| `stat-lock` | — | `<project_path>` | **CM-LOCK-01:** print `locked` or `unlocked` for `project.godot.lock` on the target FS (workers wait before commit). |
| `merge-apply` | JSON patch | `<project_root> <rel_path>` | **H-02:** structural `.tscn` merge on the target host. Patch schema matches `POST /merge`. Max stdin **1 MiB**. Atomic write via `*.pgos-merge-<pid>` → rename. Stdout: `{"ok":true,"mergedHash":"<sha256>","path":"<rel>"}`. Script patches rejected (**E019**). Path escape → **E014**. |

Unknown verbs are rejected (no shell).

#### `merge-apply` ForcedCommand example

```bash
# From Tier A runner (via pgos_ssh_agent_stdin / commit-agent-once):
# SSH_ORIGINAL_COMMAND='merge-apply /var/godot/projects/mygame scenes/player.tscn'
# patch JSON on stdin
echo '{"nodes":[{"path":"Root/Player","properties":{"position":"Vector2(10, 0)"}}]}' \
  | commit-agent -once "merge-apply /var/godot/projects/mygame scenes/player.tscn"
# → {"ok":true,"mergedHash":"…","path":"scenes/player.tscn"}
```

`install.sh` also copies `tscn-merge.mjs` to `/usr/share/pgos/tscn-merge.mjs` for host-side debugging; the agent verb itself is **pure Go** (no Node required on the target).

### Backup hierarchy (cross-machine)

| Priority | Source | When |
|----------|--------|------|
| 1 (primary) | S3 pre-commit archive from **target** via `snapshot-export` | Always for cross-machine (`PRESIGN_SNAPSHOT_PUT` required; missing → `COMMIT_FAILED` E004) |
| 2 (secondary) | `target.bak-{jobId}` on host | After commit (retained by `commit`) |
| 3 (tertiary) | Staging tarball | **Not** a rollback source |

## Install (DEP-02)

One-command install (builds + installs binary + ForcedCommand wrapper):

```bash
# From monorepo root (requires Go 1.22+):
sudo bash packages/commit-agent/scripts/install.sh

# Custom path:
sudo COMMIT_AGENT_BIN=/opt/pgos/bin/commit-agent bash packages/commit-agent/scripts/install.sh
```

`commit-agent-once` always execs `${COMMIT_AGENT_BIN:-/usr/local/bin/commit-agent}`.

Manual:

```bash
cd packages/commit-agent
go build -o /usr/local/bin/commit-agent ./cmd/agent
install -m 0755 bin/commit-agent-once /usr/local/bin/commit-agent-once
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
