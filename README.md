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
| `workers/` | GitHub Actions workflows + Godot worker scripts |
| `docs/errors/` | Deep-linked error code documentation |

**MCP name:** Vibrato  
**License:** MIT (Godot-compatible tooling; no editor licensing gate)

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
- Go 1.22+ (commit-agent)
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

- API + dashboard: http://localhost:8080  
- Sandbox: http://localhost:8090  
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

**Commit-agent** is not a Compose service (privileged host agent). Install on target machines; see `packages/commit-agent/README.md` and comments in `docker-compose.yml`.

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

1. Create Railway project with **Postgres** and **Redis** plugins.
2. Set environment variables from `.env.example` (use RS256 JWT keys in production).
3. Attach S3-compatible storage (AWS S3, R2, MinIO).
4. Deploy from repo root (`railway.toml` build/start commands). Root `npm run build` includes mcp-server; production start runs the orchestrator workspace.
5. Configure GitHub App: `actions:write` (dispatch), `actions:read` (poll runs).
6. Store `PGOS_BASE_URL` and tokens as GitHub Actions secrets for worker workflows.

## API surface (selected)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| POST | `/api/v1/jobs` | operator | Create generation job |
| PATCH | `/api/v1/jobs/:id/status` | callback/operator | Lifecycle updates |
| PATCH | `/api/v1/jobs/:id/heartbeat` | callback | 15s liveness |
| GET | `/api/v1/locks` | viewer | Active locks + fencing tokens |
| POST | `/api/v1/locks/reclaim` | admin | Force reclaim + new token |
| POST | `/api/v1/projects/:id/uid-reservations` | operator | Concurrent UID reservation |
| POST | `/api/v1/resolve-secret` | dispatch JWE | Single-use secret exchange (callback embedded in JWE) |
| POST | `/api/v1/execute-extension` | operator | Sandboxed extension proxy |
| POST | `/api/v1/merge` | operator | Override merge (script → admin) |
| GET | `/ws` | auth | Real-time job events |

## Acceptance criteria mapping

| Criterion | Implementation |
|-----------|----------------|
| Fencing under Redis failover | `LockService.rotateInstanceIdOnFailover`, composite tokens, validate rejects old `instanceId` |
| Cross-machine crash recovery | commit-agent idempotent rename + pending sidecar |
| Reimport retries | `workers/scripts/run-generation.sh` backoff 10s/30s, max 2 |
| UID concurrency | `UidService.reserve` advisory + row lock |
| Nightly UID reconcile | BullMQ `pgos-uid-reconcile` |
| Extension sandbox | `sandbox-service` network deny-by-default, timeout kill |
| Tier parity | `parity_canary.yml` + dashboard |
| Dead-letter 24/72h | `dead-letter-escalate` worker |
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
- Callback tokens expire in 5 minutes and are job-scoped.
- Sensitive worker material is never plain workflow inputs — JWE reference + single-use resolve.
- Rate limiting is a Redis sliding window per principal.

## Vibrato MCP server

Stdio MCP transport proxies PGOS REST API. Included in root `npm run build` (also `npm run build:mcp`):

```bash
npm run build
PGOS_BASE_URL=http://localhost:8080 PGOS_API_TOKEN=<operator-jwt> npm run start -w @vibrato/mcp-server
# or: npx vibrato-mcp   (after install/link; bin → packages/mcp-server/dist/index.js)
```

Tools: `list_projects`, `list_jobs`, `get_job`, `get_job_status`, `create_job`, `list_locks`.

## Documentation

- [AGENTS.md](./AGENTS.md) — Godot-specific agent guide
- [workers/README.md](./workers/README.md) — GHA secrets & Tier A setup
- [docs/errors/](./docs/errors/) — E001+ operator playbooks
- Blueprint source: your Railway PGOS specification (sections 1–14)
