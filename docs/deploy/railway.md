# Railway deployment — orchestrator + sandbox (M-08 / M-09)

PGOS is **two Railway services**, not one. The root `railway.toml` deploys the **orchestrator** (API, dashboard static, BullMQ workers). Extension execution runs in **`packages/sandbox-service`** as a separate process so untrusted code never shares the orchestrator container.

## Services

| Service | Config | Start | Healthcheck |
|---------|--------|-------|-------------|
| **orchestrator** | repo root `railway.toml` | `npm run db:migrate && npm run start -w @vibrato/orchestrator` | **`GET /ready`** (Postgres + Redis) |
| **sandbox** | `packages/sandbox-service/railway.toml` | `node dist/index.js` (Dockerfile) | `GET /health` |

### Why not a single container?

- Orchestrator principle: **never run Godot / untrusted extension code in-process**.
- Sandbox may later require Firecracker / privileged paths that do not belong on the API node.
- Independent scaling and restart domains.

## Deploy order (checklist)

1. **Create Railway project** with **Postgres** and **Redis** plugins (attach to orchestrator service).
2. **Deploy orchestrator** from repo root (Nixpacks `npm ci && npm run build`).
3. Set orchestrator **production env** from `.env.example` (RS256 JWT keys, `JWE_SECRET`, `GITHUB_*`, S3, `PUBLIC_BASE_URL`, bootstrap admin password when no admin exists).
4. Confirm orchestrator **`GET /ready`** returns `200` after Postgres + Redis are reachable.  
   - `GET /health` always returns 200 if the process is up — **do not** use it for Railway healthchecks (M-09).
5. **Deploy sandbox** as a second service:
   - Root directory: `packages/sandbox-service`
   - Config: `packages/sandbox-service/railway.toml` (Dockerfile build)
6. Set sandbox env:
   - `SANDBOX_INTERNAL_TOKEN` — long random secret (**not** `dev-sandbox-token`)
   - `PORT` — Railway injects this; Dockerfile exposes `8090` as default locally
   - **`SANDBOX_BACKEND=worker_thread`** — **H-08 Path B (signed production default)** for Railway/containers without `/dev/kvm`. No `FIRECRACKER_*` required. Health reports `firecrackerReady: false`, `sandboxPolicy: worker_thread_only`.
   - Optional Firecracker real (Path A, deferred): `SANDBOX_BACKEND=firecracker`, `FIRECRACKER_LAUNCHER_MODE=real`, `FIRECRACKER_SOCKET`, `FIRECRACKER_LAUNCHER` — see issue tracker “Firecracker real microVM spawn” (not wired in-repo; launcher exits `FIRECRACKER_REAL_NOT_WIRED` until integrated).
7. **Wire orchestrator → sandbox** (M-08):
   ```text
   SANDBOX_SERVICE_URL=http://<sandbox-private-host>:<port>
   SANDBOX_INTERNAL_TOKEN=<same as sandbox>
   ```
   Prefer Railway **private networking** reference variables, e.g.:
   ```text
   SANDBOX_SERVICE_URL=http://${{sandbox.RAILWAY_PRIVATE_DOMAIN}}:${{sandbox.PORT}}
   ```
   (Replace `sandbox` with the Railway service name you chose.)
8. Redeploy orchestrator so it picks up `SANDBOX_SERVICE_URL`.
9. Smoke:
   - Orchestrator: `curl -sS https://<orchestrator>/ready`
   - Sandbox (with token): `curl -sS -H "Authorization: Bearer $SANDBOX_INTERNAL_TOKEN" https://<sandbox-public-or-private>/health`
   - Extension execute path via dashboard / `POST /api/v1/execute-extension`
10. Configure **GitHub App** + Actions secrets (`PGOS_BASE_URL`, admin token) for workers.

## Health endpoints

| Path | Service | Meaning |
|------|---------|---------|
| `/health` | orchestrator | Process liveness only — **not** dependency-aware |
| `/ready` | orchestrator | **503** if `SELECT 1` (Postgres) or Redis `PING` fails |
| `/health` | sandbox | Service up + Firecracker readiness flags (auth skipped for `/health`) |

### Local verification of `/ready` → 503

With orchestrator running against dead deps (wrong `DATABASE_URL` / `REDIS_URL`), or in unit tests:

```bash
npm test -w @vibrato/orchestrator -- tests/readiness.test.ts
```

`checkOrchestratorReadiness` returns `{ ok: false, statusCode: 503 }` when `query` or `ping` throws.

## Environment map

### Orchestrator (required production)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (Railway plugin) |
| `REDIS_URL` | Redis (Railway plugin / BullMQ) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | RS256 |
| `JWE_SECRET` | Dispatch secret envelope |
| `PUBLIC_BASE_URL` | Public HTTPS origin |
| `SANDBOX_SERVICE_URL` | **Base URL of sandbox service** (M-08) |
| `SANDBOX_INTERNAL_TOKEN` | Shared bearer with sandbox |
| `PGOS_PROVISION_TOKEN` | **SEC-02 / DEP-01:** Bearer for target JIT SSH provisioner (`POST …/v1/provision`). Same value as on each target host. **Not** the sandbox token (production rejects empty / default / equal-to-sandbox). |
| `PGOS_PROVISION_MTLS_CERT` | **SEC-01 (recommended):** client cert PEM path for provision HTTPS |
| `PGOS_PROVISION_MTLS_KEY` | **SEC-01:** client key PEM path (required if CERT set) |
| `PGOS_PROVISION_MTLS_CA` | **SEC-01:** optional CA to trust target provisioner server cert |
| `GITHUB_*` | App dispatch |
| `S3_*` | Artifact storage |

### Cross-machine target hosts (not Railway)

JIT key install runs on the **Godot target**, not in Railway:

| Component | Location |
|-----------|----------|
| `packages/target-provisioner` | systemd on target (`127.0.0.1:9071` + reverse proxy) |
| `commit-agent` + `commit-agent-once` | target PATH / ForcedCommand (`scripts/install.sh`) |
| Project metadata | `targetHost`, `targetProvisionUrl` e.g. `https://target.internal:9071/v1/provision` |

#### Provision auth checklist (SEC-01 / SEC-02)

| Priority | Control | Notes |
|----------|---------|-------|
| **1 (recommended)** | **Client mTLS** | Set `PGOS_PROVISION_MTLS_CERT` + `PGOS_PROVISION_MTLS_KEY` on orchestrator; on target set `PGOS_PROVISION_TLS_CERT`/`KEY` + `PGOS_PROVISION_TLS_CLIENT_CA` |
| **2 (required)** | **Dedicated bearer** | `PGOS_PROVISION_TOKEN` distinct from `SANDBOX_INTERNAL_TOKEN` on both sides |
| Avoid | Bearer-only over public internet | Use VPN / private network if mTLS not yet enabled |

See `packages/target-provisioner/README.md`.

### Sandbox

| Variable | Purpose |
|----------|---------|
| `SANDBOX_INTERNAL_TOKEN` | Must match orchestrator |
| `PORT` | Listen port (Railway sets automatically) |
| `SANDBOX_BACKEND` | **Production default: `worker_thread`** (H-08 Path B). Aliases: `worker_thread_policy_enforcer`. Use `firecracker` only with real launcher. |
| `FIRECRACKER_LAUNCHER_MODE` | `stub` (default) or `real` — production forbids stub when socket set |
| `FIRECRACKER_SOCKET` / `FIRECRACKER_LAUNCHER` | Required only for Path A real microVMs |

### Production backend sign-off (H-08)

| Choice | Env | When |
|--------|-----|------|
| **B — worker_thread only (default)** | `SANDBOX_BACKEND=worker_thread` | Railway / no KVM — **signed default for v2.0** |
| **A — Firecracker real** | `FIRECRACKER_LAUNCHER_MODE=real` + socket + launcher | Dedicated bare-metal with `/dev/kvm` — **deferred** until launcher implements spawn |

## References

- Root config: [`railway.toml`](../../railway.toml)
- Sandbox config: [`packages/sandbox-service/railway.toml`](../../packages/sandbox-service/railway.toml)
- Env template: [`.env.example`](../../.env.example)
- Compose local dual-service: [`docker-compose.yml`](../../docker-compose.yml) (`SANDBOX_SERVICE_URL=http://sandbox:8090`)
