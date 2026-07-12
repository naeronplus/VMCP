# Vibrato PGOS — Procedural Generation Orchestration Service

Railway-first distributed system for **transactional, auditable** Godot asset/scene generation.

| Component | Role |
|-----------|------|
| `packages/orchestrator` | Fastify REST + WebSocket API, BullMQ, locking, dispatch |
| `packages/dashboard` | React operator UI (served by orchestrator) |
| `packages/shared` | Types, error catalog, fencing helpers, path security |
| `packages/sandbox-service` | Extension execution control plane (Firecracker-ready) |
| `packages/mcp-server` | Stdio MCP transport (`vibrato-mcp`) proxying PGOS REST |
| `packages/commit-agent` | Go minimal privileged agent for cross-machine atomic rename |
| `packages/target-provisioner` | Go JIT SSH provisioner on Godot target hosts (DEP-01) |
| `workers/` | GitHub Actions workflows + Godot worker scripts |
| `docs/errors/` | Deep-linked error code documentation |

**MCP name:** Vibrato  
**License:** [MIT](./LICENSE) (Godot-compatible tooling; no editor licensing gate)

## Repository (L-11)

CI runs on every **push** to `main`/`master` and on **pull requests** (`.github/workflows/ci.yml`).

```bash
# After creating an empty hosting repo:
export PGOS_GIT_ORIGIN='https://github.com/<org>/<repo>.git'
bash scripts/configure-git-remote.sh
# Optional first push (requires network + credentials):
# PGOS_GIT_PUSH=1 bash scripts/configure-git-remote.sh
```

Branch protection (require CI green, disallow force-push): see [`docs/deploy/git-hosting.md`](./docs/deploy/git-hosting.md).

## Principles

1. **Push, not pull** — `workflow_dispatch` starts workers.
2. **Orchestrator never runs Godot.**
3. **S3 only** for worker artifacts (no Railway volume for workers).
4. **Reentrant locks + composite fencing tokens** `{instanceId}:{counter}` with Redis+Postgres double-write.
5. **Sandboxed extensions** out-of-process (not in the Railway container).

## Quick start (local)

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- Docker + Compose (Postgres, Redis, MinIO, optional full app stack)
- Go 1.22+ (commit-agent + target-provisioner)
- Optional: Godot 4.3+ for worker scripts

### Option A — Full stack via Docker Compose (recommended fresh clone)

Compose builds **shared + dashboard + orchestrator** and **sandbox** inside containers so a clean clone does not need host `dist/` artifacts. The dashboard UI is served by the orchestrator from `packages/dashboard/dist`.

```bash
cd VMCP
cp .env.example .env
bash scripts/generate-jwt-keys.sh
# Defaults in .env already point at ./secrets/jwt-private.pem and ./secrets/jwt-public.pem

docker compose up --build
```

Compose **waits for healthy services** (DEP-03): orchestrator `GET /ready`, sandbox `GET /health` (10s interval). Dependents use `condition: service_healthy` where applicable.

- API + dashboard: http://localhost:8080  
- Sandbox: http://localhost:8090  
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

**Commit-agent** and **target-provisioner** are not Compose services (run on Godot target hosts). Install on targets with `bash packages/commit-agent/scripts/install.sh` (DEP-02); see `packages/commit-agent/README.md`, `packages/target-provisioner/README.md`, and `docker-compose.yml` comments. Cross-machine metadata: `targetHost` + `targetProvisionUrl`; orchestrator env `PGOS_PROVISION_TOKEN` (SEC-02) and optional mTLS PEMs (SEC-01).

Hot-reload (dev profile):

```bash
docker compose --profile dev up orchestrator-dev sandbox-dev postgres redis minio minio-init
```

### Option B — Host Node + infrastructure only

```bash
cd VMCP
docker compose up -d postgres redis minio minio-init
cp .env.example .env
bash scripts/generate-jwt-keys.sh
npm install
npm run build          # shared, orchestrator, dashboard, sandbox-service, mcp-server
npm run db:migrate
npm run start -w @vibrato/orchestrator
# optional: npm run start -w @vibrato/sandbox-service
```

Dev with watchers:

```bash
npm run dev -w @vibrato/orchestrator
npm run dev -w @vibrato/dashboard   # Vite HMR (optional; prod-like serves static dist)
```

Default bootstrap admin: `admin@localhost` / `admin-change-me`

### Commit agent (target hosts)

```bash
cd packages/commit-agent
go mod tidy
go build -o bin/commit-agent ./cmd/agent
```

## Build

Root build compiles **all TypeScript workspaces**, including the MCP server:

```bash
npm ci
npm run build
# equivalent pieces:
#   npm run build:shared
#   npm run build:orchestrator
#   npm run build:dashboard
#   npm run build:sandbox
#   npm run build:mcp
```

After build, `packages/mcp-server/dist/index.js` exists and is the `vibrato-mcp` bin entry.

## Lint & typecheck

```bash
npm run typecheck   # all five TS workspaces
npm run lint        # tsc --noEmit on shared, orchestrator, dashboard, sandbox-service, mcp-server
```

## Railway deployment

**Two services are required** (M-08): **orchestrator** (this repo root `railway.toml`) and **sandbox-service** (`packages/sandbox-service/railway.toml`). A single Railway service leaves extensions without a real execution plane.

Full guide: **[docs/deploy/railway.md](./docs/deploy/railway.md)**.

### Deploy checklist

1. Create Railway project with **Postgres** and **Redis** plugins (attach to orchestrator).
2. Set orchestrator env from `.env.example` (RS256 JWT keys, `JWE_SECRET`, GitHub App, S3, `PUBLIC_BASE_URL`, bootstrap admin password when needed).
3. Deploy **orchestrator** from repo root (`npm ci && npm run build`; start migrates DB then runs `@vibrato/orchestrator`).
4. Confirm Railway **healthcheck** is **`/ready`** (not `/health`) — root `railway.toml` sets `healthcheckPath = "/ready"` (M-09). `/ready` returns **503** if Postgres or Redis is down; `/health` is liveness-only.
5. Deploy **sandbox** as a second service (root directory `packages/sandbox-service`, Dockerfile). Set `SANDBOX_INTERNAL_TOKEN` (not the dev default).
6. **Wire** orchestrator → sandbox (required):
   ```text
   SANDBOX_SERVICE_URL=http://${{sandbox.RAILWAY_PRIVATE_DOMAIN}}:${{sandbox.PORT}}
   SANDBOX_INTERNAL_TOKEN=<same secret as sandbox service>
   ```
   (Adjust service name to match Railway UI.) Redeploy orchestrator after setting these.
7. Attach S3-compatible storage (AWS S3, R2, MinIO) on orchestrator.
8. Configure GitHub App: `actions:write` (dispatch), `actions:read` (poll runs).
9. Store `PGOS_BASE_URL` and tokens as GitHub Actions secrets for worker workflows.
10. Smoke: `curl -sS "$PUBLIC_BASE_URL/ready"` → `{"ok":true}`; exercise an extension execute once.

Local dual-service reference (Compose already sets `SANDBOX_SERVICE_URL=http://sandbox:8090`):

```bash
docker compose up --build
curl -sS http://localhost:8080/ready
curl -sS http://localhost:8090/health
```

## API surface (selected)

Roles use minimum rank (`requireRole`) unless marked **exact** (`requireExactRole`). Exact roles reject higher ranks (e.g. operator JWT cannot call callback-only routes).

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| POST | `/api/v1/jobs` | operator+ | Create generation job |
| GET | `/api/v1/jobs` | viewer+ | List jobs |
| GET | `/api/v1/jobs/:id` | viewer+ | Job detail |
| PATCH | `/api/v1/jobs/:id/status` | **callback only** (exact) | Worker lifecycle updates — job-scoped callback token; not usable by operator/admin JWT |
| PATCH | `/api/v1/jobs/:id/heartbeat` | **callback only** (exact) | 15s liveness — same token scope as status; fencing reject → **E013** (L-01) |
| GET | `/api/v1/dead-letter` | operator+ | Inspect dead-letter queue |
| POST | `/api/v1/dead-letter/:jobId/retry` | admin | Re-queue a dead-lettered job |
| GET | `/api/v1/locks` | viewer+ | Active locks + fencing tokens |
| GET | `/api/v1/locks/:lockKey/history` | viewer+ | Lock fencing history |
| POST | `/api/v1/locks/reclaim` | admin | Force reclaim + new fencing token; affected jobs redispatched or dead-lettered |
| POST | `/api/v1/locks/validate-token` | operator+ | Commit-agent fencing validation |
| POST | `/api/v1/projects/:id/uid-reservations` | operator+ | Concurrent UID reservation |
| POST | `/api/v1/resolve-secret` | dispatch JWE | Single-use secret exchange; 404 → `{ error: { code: 'SECRET_NOT_FOUND' } }` (L-02; not E007) |
| POST | `/api/v1/execute-extension` | operator+ | Sandboxed extension proxy |
| POST | `/api/v1/merge` | operator+ | Override merge (script patches → admin, E019) |
| GET | `/ws` | auth | Real-time job events |

### Operator / admin job intervention (not via `PATCH .../status`)

Workers alone advance lifecycle through `PATCH /jobs/:id/status` with a short-lived **callback** token (`requireExactRole('callback')` in `routes/jobs.ts`). Operators and admins **cannot** PATCH status; they use:

| Need | Endpoint | Role |
|------|----------|------|
| Create / enqueue work | `POST /api/v1/jobs` | operator+ |
| Unstick a held lock / stale job | `POST /api/v1/locks/reclaim` | admin |
| Inspect failed max-attempt jobs | `GET /api/v1/dead-letter` | operator+ |
| Retry after remediation | `POST /api/v1/dead-letter/:jobId/retry` | admin |
| Read job state / errors | `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, `GET /api/v1/jobs/errors/search` | viewer+ |
| Dashboard | operator UI (same APIs) | role-gated nav |

## Acceptance criteria mapping

| Criterion | Implementation |
|-----------|----------------|
| Fencing under Redis failover | `rotateInstanceIdOnFailover` + `lock_fencing_seq` **FAILOVER** rows (M-17); validate rejects old instanceId and `reason=FAILOVER` |
| Cross-machine crash recovery | commit-agent idempotent rename + pending sidecar |
| Reimport retries | Orchestrator `REIMPORT_TIMEOUT_MS` / `REIMPORT_MAX_RETRIES` (L-05) → JWE → worker `REIMPORT_*`; `run-generation.sh` backoff 10s/30s |
| UID concurrency | `UidService.reserve` advisory + row lock |
| Nightly UID reconcile | BullMQ `pgos-uid-reconcile` + local file rewrite; remote auto-dispatch `uid_reconcile.yml` when `metadata.targetHost` set (H-03) |
| Extension sandbox | `sandbox-service` network deny-by-default; **production default `SANDBOX_BACKEND=worker_thread`** (H-08 Path B); Firecracker real optional + fail-closed if advertised |
| dependsOnJobId ordering | Create/dispatch/promote gates (BLOCKED until COMPLETED; E011 on dep failure) |
| Structural `.tscn` merge | `POST /merge` local FS or merge_outbox; **consumer applies/dispatches** every 5m (H-02); script patches require admin (E019) |
| Tier parity | `parity_canary.yml` + dashboard |
| Dead-letter 24/72h | Consumer emails project `admin_contacts` (+ `ADMIN_EMAIL` CC); hourly 24h/72h escalate |
| Token revocation | Redis set + Postgres `token_revocations` |
| Path traversal | `@vibrato/shared` `assertWithinBase` |
| Script override | `patchIntroducesScript` requires admin |

## GitHub Actions layout

Workflows live at **repo root** `.github/workflows/` (required by GitHub) and are mirrored under `workers/.github/workflows/` for packaging. Worker shell scripts stay in `workers/scripts/`.

CI (`.github/workflows/ci.yml`) runs typecheck, **lint (all TS workspaces)**, test, full monorepo build, asserts `packages/mcp-server/dist/index.js`, workflow mirror verify, shellcheck, and commit-agent Go tests.

## Tests

```bash
npm test
npm test -w @vibrato/shared
npm test -w @vibrato/orchestrator
npm run typecheck
npm run lint
npm run build
```

## Security notes

- Production **must** use RS256 JWT key pair (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`).
- Callback tokens expire in 5 minutes and are **job-scoped**. They are the **only** credential accepted on `PATCH /jobs/:id/status` and `PATCH /jobs/:id/heartbeat` (`requireExactRole('callback')` — operator/admin JWTs are rejected).
- Sensitive worker material is never plain workflow inputs — JWE reference + single-use resolve.
- Rate limiting is a Redis sliding window per principal.

## Vibrato MCP server

Stdio MCP transport proxies PGOS REST API. Included in root `npm run build` (also `npm run build:mcp`):

```bash
npm run build
PGOS_BASE_URL=http://localhost:8080 PGOS_API_TOKEN=<operator-jwt> npm run start -w @vibrato/mcp-server
# or: npx vibrato-mcp   (after install/link; bin → packages/mcp-server/dist/index.js)
```

Canonical tool names (`VIBRATO_TOOL_NAMES` in `packages/mcp-server/src/tool-schemas.ts` — keep README in sync):

| Tool | Purpose |
|------|---------|
| `list_projects` | List projects |
| `list_jobs` | List jobs (optional `projectId`) |
| `get_job` | Full job record |
| `create_job` | Enqueue generation |
| `list_locks` | List locks |
| `get_job_status` | Job status / progress |

## Documentation

- [LICENSE](./LICENSE) — MIT
- [AGENTS.md](./AGENTS.md) — Godot-specific agent guide
- [workers/README.md](./workers/README.md) — GHA secrets, cross-machine verbs, Tier A
- [docs/e2e/cross-machine-e2e.md](./docs/e2e/cross-machine-e2e.md) — TEST-01 E2E gate (`npm run verify:r6`)
- [docs/deploy/railway.md](./docs/deploy/railway.md) — Railway deploy
- [docs/deploy/git-hosting.md](./docs/deploy/git-hosting.md) — git remote + branch protection (L-11)
- [docs/errors/](./docs/errors/) — E001+ operator playbooks
- Blueprint source: your Railway PGOS specification (sections 1–14)
