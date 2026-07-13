# PGOS Workers — GitHub Actions & Tier A Runners

Operator guide for **all** worker scripts and workflows. After reading this file you should be able to register a runner, dispatch a job, run canaries/perf, and debug cross-machine commits without hunting the tree.

**Layout**

| Path | Role |
|------|------|
| Repo root `.github/workflows/` | **Canonical** workflows GitHub executes |
| `workers/.github/workflows/` | **Mirrors** (must stay byte-identical for worker-only files) |
| `workers/scripts/` | Shell / Node entrypoints used by workflows |
| `workers/scripts/lib/` | Shared helpers sourced by scripts |
| `workers/tests/` | Local smoke / unit tests (no production secrets required) |
| `packages/commit-agent/` | Go agent + `commit-agent-once` ForcedCommand wrapper |

Verify mirrors:

```bash
node scripts/verify-workflow-mirrors.mjs
```

---

## Overview

Workers execute Godot generation jobs that the orchestrator starts with `workflow_dispatch` on `godot_worker.yml`.

**Security rules**

- Workflow **inputs** must never carry long-lived credentials. Only `secretJwe` is passed.
- Callback token, fencing token, SSH key, and presigned URLs live **inside** the JWE and are resolved via `resolve-secrets.sh`.
- Orchestrator **never** runs Godot; only runners do.

---

## Required GitHub Actions secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `PGOS_BASE_URL` | All worker workflows | Orchestrator public URL (e.g. `https://pgos.example.com`) |
| `PGOS_ADMIN_TOKEN` | `godot_health.yml`, `parity_canary.yml` | Operator/admin JWT for probe ingest / parity POST |
| `PGOS_SERVICE_TOKEN` | `merge_apply.yml` | Bearer for `POST /api/v1/merge-outbox/:id/complete` when JWE omits `callbackToken` (ENV-02; prefer token sealed in `secretJwe`) |
| `SLACK_WEBHOOK_URL` | Health, parity, perf (optional) | High-severity operator alerts |

Repo secrets are configured under GitHub → Settings → Secrets and variables → Actions.

**Never** put SSH private keys or long-lived tokens in `workflow_dispatch` inputs. Cross-machine and merge-apply material travels only inside **`secretJwe`**, resolved by `workers/scripts/resolve-secrets.sh`.

---

## Workflow catalog

Workflows live at **repo root** and are mirrored under `workers/.github/workflows/`.

### `godot_worker.yml` — job execution (primary)

| | |
|--|--|
| **Trigger** | `workflow_dispatch` only (orchestrator) |
| **Runner** | Tier A: `self-hosted` + `godot-worker`; Tier B: `ubuntu-latest` |
| **Timeout** | 90 minutes |
| **Inputs** | `jobId`, `projectId`, `godotVersion`, `commitStrategy`, `tier`, `secretJwe` |

**Step order**

1. Checkout  
2. `resolve-secrets.sh` — JWE → env + token/key files  
3. Cache `.godot-cache`  
4. `setup-godot.sh`  
5. `verify-godot.sh` (E006)  
6. PATCH `STAGING`  
7. **Single long step** “Execute job pipeline” (owns heartbeat PID for whole window):  
   - `pgos_start_heartbeat`  
   - `run-generation.sh`  
   - `atomic-commit.sh`  
   - `post-commit-verify.sh`  

Do **not** move heartbeat to a separate GHA step: PIDs die when a step ends (C-01).

### `godot_health.yml` — dual-path health (~30 min)

| | |
|--|--|
| **Trigger** | Cron `*/30 * * * *` (~**every 30 minutes**, not ~5m) + `workflow_dispatch` |
| **Runner** | `ubuntu-latest` (Tier B signal) |
| **What it does** | Probes orchestrator `/health` + `/ready`; optional cron-heartbeat staleness; `setup-godot.sh`; measures cache warmth; **POST** ` /api/v1/tiers/B/probe` (M-04) |

Requires `PGOS_BASE_URL` + `PGOS_ADMIN_TOKEN` for full probe ingest.

### `parity_canary.yml` — Tier A vs B checksum (hourly)

| | |
|--|--|
| **Trigger** | Cron `0 * * * *` + `workflow_dispatch` |
| **Matrix** | Tier A (self-hosted) `continue-on-error: true`; Tier B `ubuntu-latest` |
| **Script** | `parity-canary.sh` → artifacts `parity-out/` |
| **Compare** | Downloads both artifacts; POSTs `/api/v1/parity` |

| Outcome | Exit | E010? |
|---------|------|-------|
| Checksums match, reimport OK | 0 | No |
| Checksum mismatch | 1 | Yes |
| Reimport failed (`reimport_failed_*`) | 1 | Yes (loud) |
| Tier A missing → `skipped: true`, `reason: tier_a_unavailable` | **0** | **No** |

### `nightly_perf.yml` — reimport wall-time + MAD

| | |
|--|--|
| **Trigger** | Cron `0 4 * * *` (04:00 UTC) + `workflow_dispatch` |
| **Matrix** | 5 parallel profile runs |
| **Scripts** | `setup-godot.sh` → `perf-profile.sh` → `mad-analyze.mjs` |
| **Artifacts** | `perf-out/` per run (`wall_ms.txt`, `cpu_sec.txt`, **measured** `mem_mib.txt` + `mem_rss_kb.txt` / `mem_method.txt`) |

Fails the analyze job when robust median exceeds `PERF_P95_MS` (default **60000**).

### `merge_apply.yml` — remote structural merge (H-02)

| | |
|--|--|
| **Trigger** | `workflow_dispatch` only (orchestrator `pgos-merge-outbox` consumer) |
| **Runner** | Tier A only: `self-hosted` + `godot-worker` |
| **Timeout** | 30 minutes |
| **Inputs** | **`secretJwe`** (required), `outboxId`, `projectId`, `path`, `projectRoot`, `patchGetUrl`, `s3Key` (optional) |

**Step order**

1. Checkout  
2. `resolve-secrets.sh` — JWE → `CALLBACK_TOKEN`, **`TARGET_HOST`**, `TARGET_PROJECT_ROOT`, ephemeral SSH key file (`/tmp/pgos-ssh-key-${JOB_ID}`), optional sealed outbox fields  
3. `merge-apply.sh` — local FS apply **or** ForcedCommand `merge-apply` on target  

| Env after resolve | Source | Role |
|-------------------|--------|------|
| `TARGET_HOST` | JWE `targetHost` | Required when `PROJECT_ROOT` is not a local directory on the runner |
| `TARGET_PROJECT_ROOT` | JWE `targetProjectRoot` | Preferred over workflow `projectRoot` input |
| `CALLBACK_TOKEN` | JWE `callbackToken` | Preferred complete-callback bearer |
| `PGOS_SERVICE_TOKEN` | GitHub Actions secret | Fallback complete-callback bearer |
| `JOB_ID` | `merge-${outboxId}` | Scopes SSH key + token file paths |

**Remote apply (when project tree is only on the target host):**

```text
pgos_ssh_agent_stdin "merge-apply <project_root> <rel_path>"  < patch.json
→ commit-agent merge-apply on TARGET_HOST
→ stdout {"ok":true,"mergedHash":"…","path":"…"}
→ POST ${PGOS_BASE_URL}/api/v1/merge-outbox/${OUTBOX_ID}/complete
```

Smokes: `workers/tests/merge-apply-remote-smoke.sh`, `workers/tests/merge-apply-verb-smoke.sh`. Gate: `npm run verify:r7`.

### `ci.yml` (repo root only)

Monorepo typecheck/lint/test/build, workflow mirror verify, shellcheck, Go tests, H-02 merge-apply smokes — not a Godot worker.

---

## Tier A (self-hosted `godot-worker`)

1. Register a self-hosted runner with labels: **`self-hosted`**, **`godot-worker`**.  
2. Install Godot 4.3+ and export templates (or rely on `setup-godot.sh` + Actions cache).  
3. Ensure project root exists and is writable: `/var/godot/projects/`.  
4. For **cross-machine** jobs, install **`commit-agent` + `commit-agent-once` on target hosts** (not only the runner):

```bash
cd packages/commit-agent
go build -o /usr/local/bin/commit-agent ./cmd/agent
install -m 0755 bin/commit-agent-once /usr/local/bin/commit-agent-once
# or: go build … && cp bin/commit-agent-once /usr/local/bin/
```

**Target host env / systemd** (`pgos-commit-agent.service` under `packages/commit-agent/systemd/`):

| Variable | Purpose |
|----------|---------|
| `PGOS_AGENT_TOKEN` | Token for `POST /api/v1/locks/validate-token` (operator+) |
| `PGOS_REQUIRE_FENCING=true` | Enforce fencing on commit |
| `PGOS_URL` / `-pgos-url` | Orchestrator base URL |
| `GODOT_BIN` | Optional absolute Godot path (must match job version) |

### `commit-agent-once` wrapper

```bash
#!/usr/bin/env bash
# ForcedCommand entrypoint — packages/commit-agent/bin/commit-agent-once
exec /usr/local/bin/commit-agent -once "${SSH_ORIGINAL_COMMAND:-$*}"
```

OpenSSH `ForcedCommand=commit-agent-once` so JIT keys can **only** run PGOS verbs (no shell, no `scp`).

---

## Tier B (GitHub-hosted)

Uses `ubuntu-latest`. No host install required — workflows call `setup-godot.sh`.

### Tier B health probe (M-04)

Tier B health is **not** Redis/Postgres latency.

| Source | Path | Metrics |
|--------|------|---------|
| Railway BullMQ `tier-b-probe` (~5m) | GitHub Actions API: recent `godot_health.yml` / `godot_worker.yml` runs | `tier_b_runner_online`, cold-start from `run_started_at − created_at` |
| Scheduled `godot_health.yml` (`*/30`) | POST `/api/v1/tiers/B/probe` after setup-godot | `runnerOnline`, `godotCacheWarm`, `wallMs` |

Dashboard: **Tiers** page / `GET /api/v1/tiers`.

---

## Worker pipeline (happy path)

Heartbeat covers **generation → commit → post-commit** inside one GHA step.

| Phase | Owner | Notes |
|-------|--------|------|
| Interval | `HEARTBEAT_INTERVAL` (workflow default **15**) | `heartbeat.sh` loop |
| Stale threshold | Orchestrator `HEARTBEAT_STALE_AFTER_MS` (default **30000**) | Missed beats → E005 / lock reclaim |
| PID ownership | `pgos-lifecycle.sh` in **Execute job pipeline** only | Start before `run-generation.sh`; trap on EXIT/ERR/INT/TERM |

1. `resolve-secrets.sh`  
2. `setup-godot.sh`  
3. `verify-godot.sh`  
4. Long step: heartbeat + `run-generation.sh` + `atomic-commit.sh` + `post-commit-verify.sh`  

---

## Script reference

### `heartbeat.sh`

| | |
|--|--|
| **Role** | PATCH `/api/v1/jobs/:id/heartbeat` forever until killed |
| **Env** | `PGOS_BASE_URL`, `JOB_ID`, `CALLBACK_TOKEN`; optional `FENCING_TOKEN` |
| **Interval** | `HEARTBEAT_INTERVAL` (default **15** seconds) |
| **Failure policy (M-05)** | No `\|\| true`. After `HEARTBEAT_MAX_CONSECUTIVE_FAILURES` (default **3**) consecutive failed PATCHes → **exit 1** |
| **Transport** | `pgos_patch_job_heartbeat` → `lib/pgos-callback.sh` |

Orchestrator stale window must be **>** interval (default 30s vs 15s). Kill heartbeat during a long commit → expect E005 only after stale threshold.

```bash
export HEARTBEAT_INTERVAL=15 HEARTBEAT_MAX_CONSECUTIVE_FAILURES=3
bash workers/scripts/heartbeat.sh   # usually started via pgos_start_heartbeat
```

### `lib/pgos-lifecycle.sh`

| Function | Behavior |
|----------|----------|
| `pgos_start_heartbeat` | Backgrounds `heartbeat.sh`; sets `PGOS_HEARTBEAT_PID` |
| `pgos_stop_heartbeat` | Kills PID |
| `pgos_heartbeat_trap` | EXIT/ERR/INT/TERM → stop heartbeat + optional SSH key cleanup |

### `lib/pgos-callback.sh` (M-05 / M-06)

| Behavior | Rule |
|----------|------|
| 2xx | Success |
| 401 / 403 | Fail immediately — **no** retry |
| 5xx / network `000` | Retry up to `PGOS_CALLBACK_MAX_RETRIES` (default 3), exponential backoff |
| Other 4xx | Fail immediately |

Helpers: `pgos_patch_job_status`, `pgos_patch_job_heartbeat`. Used by generation/commit/verify/heartbeat.

### `resolve-secrets.sh` (M-07 / L-12 / H-11)

| | |
|--|--|
| **POST** | `/api/v1/resolve-secret` with `{ "jwe": "<SECRET_JWE>" }` |
| **Requires** | `PGOS_BASE_URL`, `SECRET_JWE`, `JOB_ID` |
| **Mask** | `::add-mask::` for JWE, `CALLBACK_TOKEN`, fencing, presigned URLs **before** `GITHUB_ENV` |
| **Token file** | `$RUNNER_TEMP/pgos-callback-token-$JOB_ID` mode **600** (`CALLBACK_TOKEN_FILE`) |
| **SSH key** | `/tmp/pgos-ssh-key-$JOB_ID` mode 600 — **never** in `GITHUB_ENV` |
| **Errors** | Log **HTTP status only** — never response body |

### `setup-godot.sh` / `verify-godot.sh` (E006)

**`setup-godot.sh <version>`**

- Downloads official Godot binary + export templates into `.godot-cache/` (checksum-verified).  
- Symlinks `godot` onto `PATH` (`$HOME/.local/bin`).  
- Templates → `~/.local/share/godot/export_templates/<version>.stable/` (+ `version.txt`).  
- Safe with Actions `cache` on `.godot-cache`.

**`verify-godot.sh [version]`** (H-09 / H-10)

- Exact semver equality via `lib/godot-semver.mjs` — **`4.3.1` does not match `4.3.10`**.  
- Requires non-empty export templates for the requested version.  
- On failure: PATCH `VALIDATION_FAILED` + **E006** (version vs templates detail).  

```bash
bash workers/scripts/setup-godot.sh "4.3.1"
bash workers/scripts/verify-godot.sh "4.3.1"
node --test workers/tests/godot-semver.test.mjs
```

### `run-generation.sh` / `atomic-commit.sh` / `post-commit-verify.sh`

| Script | Status transitions (via callback helper) | Notes |
|--------|------------------------------------------|-------|
| `run-generation.sh` | REIMPORT_FAILED / VALIDATING / VALIDATION_* / VALIDATION_REPORT | Staging tree under `/tmp/staging-$JOB_ID`; S3 presigns; reimport retries 10s/30s (max 2); **multi-layer validation** (below) |
| `atomic-commit.sh` | COMMITTING / PAUSED_EDITOR_LOCK / COMMIT_FAILED | Same-machine atomic `mv`; cross-machine ForcedCommand verbs |
| `post-commit-verify.sh` | POST_COMMIT_VERIFY / COMPLETED / ROLLBACK | Remote reimport default-on; S3 or `.bak-$JOB_ID` restore |

#### Multi-layer validation in `run-generation.sh` (M-11 / E003)

After successful staging reimport, status becomes **`VALIDATING`**. Both layers must pass before **`VALIDATION_REPORT`**:

| Layer | Implementation | What it checks |
|-------|----------------|----------------|
| 1. UID integrity | Inline Python in `run-generation.sh` | Duplicate `uid://` tokens across `.tscn` / `.tres` / `.gd` (skips `.godot` / `.git`) |
| 2. Node-path integrity | `validate_node_paths.gd` via headless Godot | Every `.tscn` under `res://` **loads** and **instantiates** |

```bash
# Layer 2 invocation (inside run-generation.sh after reimport)
godot --headless --path "$STAGING" --script workers/scripts/validate_node_paths.gd
# GODOT_BIN overrides the binary; NODE_PATH_TIMEOUT_SEC default 120
```

| On failure | Behavior |
|------------|----------|
| Either layer fails | PATCH **`VALIDATION_FAILED`** + **`E003`** with `errorDetail` summarizing UID and/or node-path errors |
| Report artifact | `$STAGING/validation_report.json` (uploaded when `PRESIGN_VALIDATION_PUT` is set) includes `layers.uid`, `layers.node_path`, `node_path.errors`, `node_path.logTail` |
| Godot log | `$STAGING/node_path_validation.log` |

```bash
# Smoke (no real Godot — mock binary + mock callback)
bash workers/tests/validate-node-paths-smoke.sh
```

### `parity-canary.sh` (H-12 / H-13)

| | |
|--|--|
| **Output dir** | `OUT_DIR` / default `parity-out/` |
| **Files** | `checksum.txt`, `duration.txt` (portable `Date.now()`), `reimport_status.txt` (`0`/`1`) |
| **Loud fail** | Godot missing or reimport non-zero → status `1`, script **exit 1** (no `godot … \|\| true`) |
| **Env** | `TIER`, `GODOT_VERSION`, `OUT_DIR` |

Skip when Tier A is unavailable is handled by **`parity_canary.yml` compare** (not this script alone).

```bash
TIER=B bash workers/scripts/parity-canary.sh
bash workers/tests/parity-canary-smoke.sh
```

### `perf-profile.sh` / `mad-analyze.mjs`

**`perf-profile.sh`** (M-12 / L-07)

Measures a minimal Godot headless reimport and writes metrics under `OUT_DIR` (default **`perf-out/`**):

| Artifact | Meaning |
|----------|---------|
| `wall_ms.txt` | Wall clock ms via portable `node -e "console.log(Date.now())"` (**L-07** — not `date +%s%3N`) |
| `cpu_sec.txt` | Elapsed seconds from GNU `time` `%e` (historical name; wall elapsed of the timed process) |
| `mem_mib.txt` | **Measured** peak RSS in whole MiB (**M-12** — never a hardcoded placeholder) |
| `mem_rss_kb.txt` | Peak RSS in kilobytes (raw) |
| `mem_method.txt` | How memory was measured: `gnu-time-%M` \| `gnu-time-v` \| `rss-sample` \| `no-godot` |
| `godot_exit.txt` | Godot process exit code |

**Memory measurement order (M-12)**

1. **Primary:** `PERF_TIME_BIN` or `/usr/bin/time -f '%e %M'` → `%M` is max resident set size in **KB** → MiB = round(KB/1024)  
2. **Secondary:** same binary with `-v` → parse `Maximum resident set size (kbytes)`  
3. **Fallback:** peak RSS sampling via `ps -o rss=` while Godot runs (when GNU time is unavailable)

| Env | Purpose |
|-----|---------|
| `OUT_DIR` | Output directory (default `perf-out`) |
| `GODOT_BIN` | Godot binary (default `godot`) |
| `PERF_TIME_BIN` | Override time binary (default `/usr/bin/time`; used by smoke tests) |

`nightly_perf.yml` uploads the entire `perf-out/` directory as artifact `perf-{N}` (includes `mem_mib.txt`) and asserts the measurement method is real before upload.

```bash
bash workers/scripts/perf-profile.sh
bash workers/tests/perf-profile-smoke.sh
node workers/scripts/mad-analyze.mjs artifacts
```

**`mad-analyze.mjs <artifacts-root>`**

- Loads each `*/wall_ms.txt` under the downloaded artifact tree.  
- Computes median, MAD, robust median (k=3, Fisher constant).  
- If `robustMedian > PERF_P95_MS` (default 60000) → Slack (optional) + exit 1.

### `uid-reconcile.sh` (host rewrite, H-03)

**Automatic remote path:** when orchestrator `project_root` is unreadable and project `metadata.targetHost` (or `targetProvisionUrl` / `uidReconcileUrl`) is set, nightly reconcile uploads `replacements.json` to S3 and dispatches **`uid_reconcile.yml`** (Tier A). Orchestrator audits `mode: remote_dispatched` with the workflow run id. That workflow downloads the map and runs this script.

**Manual** (no host metadata / break-glass):

```bash
# replacements.json: { "uid://OLD": "uid://NEW", ... }
bash workers/scripts/uid-reconcile.sh /var/godot/projects/<projectId> ./replacements.json
```

| | |
|--|--|
| **Does** | Full-token `uid://` rewrite under project root (skips `.git`/`.godot`); then Godot headless reimport |
| **Env** | `GODOT_BIN` (default `godot`), `UID_RECONCILE_TIMEOUT_SEC` (default 300) |
| **Exit** | `2` if reimport fails (treat as E008-class manual review) |
| **Workflow** | `.github/workflows/uid_reconcile.yml` (mirrored under `workers/.github/workflows/`) |

### `merge-apply.sh` (host structural merge, H-02)

**Automatic:** `merge_outbox` consumer (`pgos-merge-outbox` every 5m) applies locally when orchestrator `project_root` is readable; otherwise dispatches **`merge_apply.yml`** with patch on S3 + **`secretJwe`** (SSH / callback sealed). This script is the runner entrypoint.

| Mode | Condition | Behavior |
|------|-----------|----------|
| Local | `PROJECT_ROOT` is a directory on the runner | Node + `lib/tscn-merge.mjs`; atomic `*.pgos-merge-<pid>` → rename |
| Remote | Root not local **and** `TARGET_HOST` set (from JWE via `resolve-secrets`) | `pgos_ssh_agent_stdin "merge-apply …"` → commit-agent on target |
| Fail | Root not local **and** `TARGET_HOST` unset | Exit non-zero (do not invent co-location) |

**Complete callback:** on success (local or remote), `POST /api/v1/merge-outbox/:id/complete` with `{"mergedHash":"…"}` using `CALLBACK_TOKEN` or `PGOS_SERVICE_TOKEN`.

```bash
# Local co-located tree (break-glass / debug)
PROJECT_ROOT=/var/godot/projects/<id> \
REL_PATH=scenes/main.tscn \
PATCH_FILE=./patch.json \
OUTBOX_ID=<uuid> \
PGOS_BASE_URL=https://pgos.example.com \
CALLBACK_TOKEN=<token> \
bash workers/scripts/merge-apply.sh

# Remote (normal after resolve-secrets on merge_apply.yml)
# TARGET_HOST and SSH key come from secretJwe — never workflow inputs
export TARGET_HOST=deploy@godot-target.example
export PROJECT_ROOT=/var/godot/projects/<id>   # path ON the target
export REL_PATH=scenes/main.tscn
export PATCH_GET_URL=https://s3…/patch.json
export OUTBOX_ID=<uuid>
export JOB_ID=merge-<uuid>
bash workers/scripts/merge-apply.sh
```

### `validate_node_paths.gd` (M-11)

| | |
|--|--|
| **Role** | Headless SceneTree script: scan `res://` for `.tscn`, `load` + `instantiate` each scene |
| **Wired by** | `run-generation.sh` after reimport (not a standalone workflow step) |
| **Exit** | `0` + `NODE_PATH_OK` on success; `1` + `NODE_PATH_ERROR: …` lines on failure |
| **Env** | Uses project from Godot `--path` (staging root). Runner supplies `GODOT_BIN` / `godot` |

Do **not** remove this file without replacing layer 2 in `run-generation.sh` and updating E003 docs.

### Other scripts / libs

| Path | Role |
|------|------|
| `lib/pgos-remote.sh` | SSH ForcedCommand helpers, key materialize/cleanup (H-11) |
| `lib/pgos-s3.sh` | Presigned PUT/GET, tarball upload/download |
| `lib/godot-semver.mjs` | Exact version + template checks |

---

## Target host packages (cross-machine)

| Package / install | Role |
|-------------------|------|
| `packages/target-provisioner` | JIT SSH provision HTTP API (`POST /v1/provision`) on the Godot target |
| `packages/commit-agent` + `scripts/install.sh` | ForcedCommand agent (`commit-agent-once`) |
| Verbs | `snapshot-export`, `stat-lock`, `stage-receive`, `commit`, `reimport`, `restore` |

See `packages/target-provisioner/README.md` and `packages/commit-agent/README.md`.

## Cross-machine transport (C-00)

JIT SSH keys use **`ForcedCommand=commit-agent-once`**. Do **not** use `scp` or interactive shell.

| Step | Verb (`SSH_ORIGINAL_COMMAND`) |
|------|-------------------------------|
| **Pre-commit snapshot (C-03)** | `snapshot-export <target>` → tar.gz on **stdout** → `pgos_upload_file` to `PRESIGN_SNAPSHOT_PUT` |
| **Editor lock (CM-LOCK-01)** | `stat-lock <target>` → stdout `locked`\|`unlocked` for target `project.godot.lock` (not runner FS) |
| Stage | `stage-receive <remote_tmp> <sha256>` (tar.gz on **stdin**) |
| Commit | `commit <token> <source> <target> [lockKey lockOwner nonce]` |
| Verify | `reimport <target> <timeout>` |
| Rollback | `restore <target>` (stdin tar from S3) or `restore <target> <backup>` |

Helpers: `pgos_ssh_agent`, `pgos_ssh_agent_stdin`, `pgos_cleanup_ssh_key`, `pgos_upload_file`.

**C-03:** Cross-machine **never** snapshots runner-local `TARGET_ROOT`. Pre-commit: `snapshot-export` on target → `pgos_upload_file` to `PRESIGN_SNAPSHOT_PUT` (required; missing presign → `COMMIT_FAILED` E004). Primary rollback = S3 archive via `restore` stdin. Secondary = `target.bak-{jobId}` on host. Staging tarball is **not** a rollback source.

### Provisioning contract (DEP-01)

In-repo server: **`packages/target-provisioner`** (systemd on each Godot target, listen `127.0.0.1:9071`).

Orchestrator POSTs to `metadata.targetProvisionUrl` (example: `https://target.internal:9071/v1/provision`) with:

```json
{
  "publicKey": "ssh-ed25519 AAAA… pgos-ephemeral",
  "singleUse": false,
  "maxSessions": 8,
  "ttlSeconds": 300,
  "forcedCommand": "commit-agent-once",
  "environment": {
    "PGOS_LOCK_KEY": "…",
    "PGOS_LOCK_OWNER": "…",
    "PGOS_JOB_ID": "…",
    "PGOS_REQUIRE_FENCING": "true"
  }
}
```

Auth: `Authorization: Bearer $PGOS_PROVISION_TOKEN` (SEC-02; same token on orchestrator + target). Do not couple long-term to `SANDBOX_INTERNAL_TOKEN`.

Target must write OpenSSH **`environment="…"`** on the authorized key line (AcceptEnv not required). See `packages/target-provisioner/README.md`.

Job metadata **must** include both `targetHost` and `targetProvisionUrl` or dispatch ends in **`DISPATCH_FAILED`** (no SSH PEM in JWE).

### Remote verify / rollback

- Cross-machine reimport runs **on the target host** (default).  
- Break-glass only: `PGOS_REMOTE_VERIFY=0` (unsafe — validates runner FS).  
- Rollback priority: **(1)** S3 pre-commit snapshot via `restore` stdin, **(2)** `target.bak-{jobId}` on host.

### Ephemeral SSH key cleanup (H-11)

| Stage | Behavior |
|-------|----------|
| `resolve-secrets.sh` | Writes key file mode 600; never PEM in `GITHUB_ENV` |
| `atomic-commit.sh` | Failure → delete key; successful cross-machine → `PGOS_SSH_KEEP_KEY=1` for post-commit |
| `post-commit-verify.sh` | Always secure-delete on exit |
| Pipeline trap | Final safety net |

```bash
bash workers/tests/ssh-key-cleanup-smoke.sh
```

---

## Secrets & callback hardening (quick reference)

### Callback token (M-07 / L-12)

1. `::add-mask::` for secrets before `GITHUB_ENV` write.  
2. File: `$RUNNER_TEMP/pgos-callback-token-$JOB_ID` (mode 600).  
3. Env: `CALLBACK_TOKEN` + `CALLBACK_TOKEN_FILE` for later steps.  
4. Resolve errors: **HTTP status only**.  

### Callback HTTP (M-05 / M-06)

No bare `curl … || true` on status/heartbeat — use `lib/pgos-callback.sh`.

---

## Cross-machine E2E checklist (TEST-01 / plan §11.1)

Full runbook: [`docs/e2e/cross-machine-e2e.md`](../docs/e2e/cross-machine-e2e.md). Gate: `npm run verify:r6`.

| # | Scenario | Expected | Automated smoke / test |
|---|----------|----------|------------------------|
| 1 | Project + `targetHost` + `targetProvisionUrl` | JIT SSH key provisioned | `ssh-provision-integration.test.ts` |
| 2 | Happy path generation | `COMPLETED`; heartbeat throughout | `pgos-remote-protocol-smoke.sh`, `heartbeat-lifecycle-smoke.sh` |
| 3 | Bad provision URL | `DISPATCH_FAILED`; no SSH in JWE | `provision-dispatch.test.ts` |
| 4 | Wrong fencing owner | `COMMIT_FAILED` / E013 | `go test` fencing reject |
| 5 | Post-commit reimport fail | `ROLLBACK`; S3 snapshot restore | `snapshot-rollback-smoke.sh` |
| 6 | Host backup only (S3 disabled) | Restore `target.bak-{jobId}` | `host-backup-rollback-smoke.sh` |
| 7 | Editor lock on target | E012 or wait then succeed | `editor-lock-cross-machine-smoke.sh` |

Optional live run on Tier A: `.github/workflows/e2e_cross_machine.yml` (`workflow_dispatch`, secrets required).

```bash
npm run e2e:cross-machine   # scenario driver only
npm run verify:r6           # full R6 gate + report contracts
```

---

## CI worker smokes (TEST-03)

GitHub Actions job **`worker-smokes`** in `.github/workflows/ci.yml` runs **9/9** bash smokes on every PR/push (plus shellcheck, `godot-semver.test.mjs`, and C-03 snapshot smokes). This is the single worker CI surface for plan §8.1 — do not drop scripts from the job without updating this table and `scripts/verify-r3-test-ci-expansion.mjs`.

| # | Script | Finding / purpose |
|---|--------|-------------------|
| 1 | `workers/tests/pgos-s3-smoke.sh` | S3 helper (`pgos-s3.sh`) |
| 2 | `workers/tests/ssh-key-cleanup-smoke.sh` | H-11 ephemeral key cleanup |
| 3 | `workers/tests/validate-node-paths-smoke.sh` | M-11 `validate_node_paths.gd` wiring |
| 4 | `workers/tests/perf-profile-smoke.sh` | M-12 real RSS / portable timestamps |
| 5 | `workers/tests/pgos-callback-smoke.sh` | M-05/M-06 callback retry + 403 fail |
| 6 | `workers/tests/heartbeat-lifecycle-smoke.sh` | C-01 heartbeat across long window |
| 7 | `workers/tests/pgos-remote-protocol-smoke.sh` | C-00 reimport/restore/stage-receive verbs |
| 8 | `workers/tests/parity-canary-smoke.sh` | H-12 parity loud-fail + L-07 portable time |
| 9 | `workers/tests/resolve-secrets-mask-smoke.sh` | M-07/L-12 token mask + mode 600 |

**Gate:** `npm run verify:r3` re-runs all 9 smokes locally (Git Bash on Windows) and asserts CI wiring.

```bash
npm run verify:r3
```

## Local smoke tests

```bash
# From monorepo root — same 9/9 order as CI
bash workers/tests/pgos-s3-smoke.sh
bash workers/tests/ssh-key-cleanup-smoke.sh
bash workers/tests/validate-node-paths-smoke.sh
bash workers/tests/perf-profile-smoke.sh
bash workers/tests/pgos-callback-smoke.sh
bash workers/tests/heartbeat-lifecycle-smoke.sh
bash workers/tests/pgos-remote-protocol-smoke.sh
bash workers/tests/parity-canary-smoke.sh
bash workers/tests/resolve-secrets-mask-smoke.sh
# Additional (C-03 / H-09)
bash workers/tests/snapshot-export-smoke.sh
bash workers/tests/snapshot-rollback-smoke.sh
node --test workers/tests/godot-semver.test.mjs
node scripts/verify-workflow-mirrors.mjs
```

### Manual resolve against a running orchestrator

```bash
export PGOS_BASE_URL=http://localhost:8080
export JOB_ID=<uuid>
export PROJECT_ID=<uuid>
export SECRET_JWE=<dispatch-jwe-from-job>
bash workers/scripts/resolve-secrets.sh
# Then: setup-godot / verify-godot / pipeline scripts with COMMIT_STRATEGY=same-machine|cross-machine
```

### Env cheat sheet

| Variable | Default / notes |
|----------|-----------------|
| `HEARTBEAT_INTERVAL` | `15` |
| `HEARTBEAT_MAX_CONSECUTIVE_FAILURES` | `3` |
| `HEARTBEAT_STALE_AFTER_MS` | Orchestrator `30000` |
| `REIMPORT_TIMEOUT_SEC` | `300` |
| `REIMPORT_MAX_RETRIES` | `2` |
| `PGOS_CALLBACK_MAX_RETRIES` | `3` |
| `PGOS_REMOTE_VERIFY` | `1` (set `0` only for break-glass) |
| `PERF_P95_MS` | `60000` (mad-analyze) |
| `GODOT_VERSION` / `GODOT_BIN` | Job / host Godot |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| E005 lock stale mid-job | Heartbeat step ownership; interval vs `HEARTBEAT_STALE_AFTER_MS`; callback 401/403 |
| E006 on verify | Exact version string; export templates dir + `version.txt` |
| E002 post-commit | Reimport log; remote vs runner FS; snapshot restore |
| E010 parity false positive | Tier A down should **skip**, not fail; reimport must be loud |
| Tier B always degraded | `godot_health.yml` secrets; Actions API; `/api/v1/tiers` probe fields |
| `DISPATCH_FAILED` cross-machine | Missing `targetHost` or `targetProvisionUrl` |
| SSH / fencing reject | `environment=` on key line; `PGOS_LOCK_*`; `commit-agent-once` on PATH |

Further playbooks: repo `docs/errors/E00x.md` and dashboard **Error catalog**.
