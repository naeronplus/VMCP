# VMCP (Vibrato PGOS) — Comprehensive Audit Report

**Project path:** `C:\Users\makem\Desktop\VMCP`  
**Audit date:** 2026-07-12  
**Auditor:** Automated full-stack audit (source review, acceptance-criteria mapping, automated verification)  
**Scope:** Entire monorepo — orchestrator, dashboard, shared, sandbox-service, mcp-server, commit-agent, workers, CI/CD, docs, deployment configs

---

## Executive Summary

VMCP is a **well-architected, production-oriented** Procedural Generation Orchestration Service (PGOS) for Godot asset generation. The codebase demonstrates strong fundamentals: reentrant locking with composite fencing tokens, JWE-based secret dispatch, a complete E001–E020 error catalog, broad orchestrator unit tests, and synchronized GitHub workflow mirrors.

However, several **critical cross-machine worker gaps** and **partial feature implementations** prevent the system from meeting its documented acceptance criteria end-to-end. The most severe issues cluster around:

1. **Worker heartbeat coverage** stopping before long-running commit/verify phases (risk of false E005 lock reclamation).
2. **Cross-machine commit pipeline** missing remote post-commit verification, remote rollback, `commit-agent-once` wrapper, and per-job lock-owner propagation over SSH.
3. **Feature stubs** presented as complete: structural merge (DB-only), UID nightly reconcile (DB-only, no Godot rewrite), Firecracker sandbox launcher, dead-letter consumer worker.

**Automated verification (this audit run):**

| Check | Result |
|-------|--------|
| `npm run typecheck` | ✅ Pass (5 workspaces) |
| `npm test` | ✅ Pass — 53 tests across shared (16), orchestrator (31), mcp-server (1), sandbox (2), dashboard (3) |
| `npm run build` | ✅ Pass (shared, orchestrator, dashboard, sandbox-service) |
| `go test ./...` (commit-agent) | ✅ Pass |
| `node scripts/verify-workflow-mirrors.mjs` | ✅ Pass — 4 workflows mirrored |
| `npm run lint` | ✅ Pass (orchestrator tsc only) |
| Git repository | ❌ **Not initialized** — no `.git` directory |

**Finding counts:**

| Severity | Count |
|----------|-------|
| Critical | 6 |
| High | 14 |
| Medium | 18 |
| Low | 12 |
| Informational (pass) | 15 |

---

## 1. Project Architecture

### 1.1 Component Map

| Component | Path | Role |
|-----------|------|------|
| Orchestrator | `packages/orchestrator` | Fastify REST + WebSocket API, BullMQ workers, locking, GitHub dispatch |
| Dashboard | `packages/dashboard` | React 19 operator UI (served statically by orchestrator in prod) |
| Shared | `packages/shared` | Types, error catalog, fencing helpers, path security |
| Sandbox service | `packages/sandbox-service` | Extension execution control plane |
| MCP server | `packages/mcp-server` | Stdio MCP transport proxying PGOS REST (`Vibrato`) |
| Commit agent | `packages/commit-agent` | Go privileged agent for cross-machine atomic rename |
| Workers | `workers/` | GitHub Actions workflows + Godot shell scripts |

### 1.2 Design Principles (verified in code)

| Principle | Status |
|-----------|--------|
| Push, not pull (`workflow_dispatch`) | ✅ Implemented |
| Orchestrator never runs Godot | ✅ Workers only |
| S3-only worker artifacts | ✅ Presigned URLs in JWE envelope |
| Reentrant locks + composite fencing `{instanceId}:{counter}` | ✅ Redis Lua + Postgres ledger |
| Sandboxed extensions out-of-process | ⚠️ Proxy exists; Firecracker is stub |

### 1.3 npm Workspaces

**Included:** `shared`, `orchestrator`, `dashboard`, `sandbox-service`, `mcp-server`  
**Excluded:** `commit-agent` (Go module, built via `npm run agent:build`)

---

## 2. Critical Findings

### C-01 — Heartbeat stops before commit and post-commit phases

**Location:** `.github/workflows/godot_worker.yml:85–101`, `workers/scripts/heartbeat.sh`  
**Impact:** Orchestrator marks jobs stale after `HEARTBEAT_STALE_AFTER_MS=30000` (30s). `atomic-commit.sh` can block up to **5 minutes** on `project.godot.lock`; `post-commit-verify.sh` can run Godot up to **300s × 3 attempts**. Heartbeat runs only inside the "Stage, reimport, validate" step and is killed on step exit.

**Risk:** False **E005 LOCK_STALE** reclamation mid-commit, corrupting generation state.

**Remediation:** Run heartbeat as a background process from `resolve-secrets.sh` through the final step, or wrap commit + post-commit in a single step with heartbeat.

---

### C-02 — Cross-machine post-commit verification runs on worker, not target host

**Location:** `workers/scripts/post-commit-verify.sh:25`, `workers/scripts/atomic-commit.sh:60–101`  
**Impact:** For `commitStrategy != same-machine`, committed assets live on `TARGET_HOST`, but post-commit Godot reimport runs `godot --path "$TARGET_ROOT"` on the GitHub Actions runner. Verification is a no-op or validates the wrong filesystem.

**Remediation:** SSH to `TARGET_HOST` and run headless Godot reimport remotely; only mark `COMPLETED` after remote validation succeeds.

---

### C-03 — Cross-machine rollback restores locally, not on target

**Location:** `workers/scripts/post-commit-verify.sh:37–53`  
**Impact:** S3 snapshot rollback uses `cp -a` to local `TARGET_ROOT`. When commit succeeded on a remote host, rollback does not restore the remote project tree.

**Remediation:** Remote rollback via SSH + commit-agent or tarball restore on `TARGET_HOST`.

---

### C-04 — `commit-agent-once` SSH wrapper missing

**Location:** `packages/orchestrator/src/services/job-service.ts:294`, `packages/commit-agent/cmd/agent/main.go:71`  
**Impact:** Orchestrator provisions SSH `forcedCommand: "commit-agent-once"`, but the repository ships only `commit-agent` with a `-once` flag. No wrapper script or symlink exists in `packages/commit-agent` or `workers/scripts/`.

**Risk:** Cross-machine commits fail at SSH unless operators manually install an undocumented wrapper.

**Remediation:** Ship `commit-agent-once` as `exec commit-agent -once "$SSH_ORIGINAL_COMMAND"` and document in `packages/commit-agent/README.md`.

---

### C-05 — Per-job lock owner not propagated to remote commit-agent

**Location:** `workers/scripts/atomic-commit.sh:90–95`, `packages/commit-agent/cmd/agent/main.go:238–258`  
**Impact:** Resolved secrets include `lockOwner: job:{jobId}` (`job-service.ts:218,276`). Worker exports `PGOS_LOCK_KEY`/`PGOS_LOCK_OWNER` locally but the remote SSH command is:

```bash
ssh "$TARGET_HOST" "commit ${FENCING_TOKEN} ${REMOTE_TMP} ${TARGET_ROOT}"
```

Remote commit-agent reads owner from **static host env** (`PGOS_LOCK_OWNER`), not per-job values. `validateFencingToken` requires `latest.owner === owner` (`lock-service.ts`). Mismatch causes fencing rejection (E004/E013).

**Remediation:** Pass lock key/owner in forced command env, provision per-job wrapper, or embed in commit token validation path.

---

### C-06 — SSH public-key provision failures ignored before dispatch

**Location:** `packages/orchestrator/src/services/job-service.ts:295–304`  
**Impact:** `provisionPublicKey()` return value is never checked. Dispatch continues and embeds SSH private key in JWE even when key installation failed.

**Remediation:** Abort dispatch (or set `COMMIT_FAILED` / `DISPATCH_FAILED`) when `provisionPublicKey` returns `{ ok: false }`.

---

## 3. High-Severity Findings

### H-01 — `dependsOnJobId` not enforced at job creation or dispatch

**Location:** `packages/orchestrator/src/services/job-service.ts:153–171,663–672`  
**Impact:** Field is stored but create only blocks on concurrent active jobs (`blocked_by_job_id`), not incomplete dependencies. A job can dispatch while its dependency is still running. Dependency failure is only handled when promoting `BLOCKED` jobs after a finished dependency.

---

### H-02 — Structural merge is not implemented (DB registry only)

**Location:** `packages/orchestrator/src/services/merge-service.ts`  
**Impact:** `POST /api/v1/merge` inserts into `overrides` table with script-injection detection. AGENTS.md and README describe node matching, property merge, and sub-resource UID merge. No `.tscn` file is read or written.

---

### H-03 — UID nightly reconcile is database-only

**Location:** `packages/orchestrator/src/services/uid-service.ts:152–199`, `health-worker.ts` uid worker  
**Impact:** `autoResolveDuplicates()` updates `uid_mappings` rows only. AGENTS.md promises scanning project files for `uid://` strings and rewriting references via headless Godot. No file I/O or Godot invocation exists in orchestrator or worker reconcile path.

---

### H-04 — `mcp-server` excluded from root `npm run build`

**Location:** `package.json:14`  
**Impact:** `typecheck` and `test` include `@vibrato/mcp-server`, but `build` does not. CI build step won't produce `dist/index.js` for the `vibrato-mcp` bin. README documents `npm run build -w @vibrato/mcp-server` as a separate manual step.

---

### H-05 — `docker-compose` orchestrator build is incomplete

**Location:** `docker-compose.yml:58`  
**Impact:** Command runs `npm run build -w @vibrato/shared` only, then `dev` orchestrator. Dashboard UI and orchestrator TypeScript are not compiled unless `dist/` already exists from a prior host build. Fresh clone + `docker compose up` may serve API without dashboard static assets.

---

### H-06 — Dashboard: no Projects page; job enqueue blocked on empty DB

**Location:** `packages/dashboard/src/App.tsx`, `packages/dashboard/src/pages/JobsPage.tsx`  
**Impact:** `POST /api/v1/projects` requires admin role but no UI exists to create projects. Jobs page "Enqueue generation" is disabled without a project. `api/client.ts` has no `createProject()` method.

---

### H-07 — Dashboard RBAC: nav visible but API returns 403

**Location:** `packages/dashboard/src/App.tsx:46–48`, `packages/orchestrator/src/routes/extensions.ts:67`, `packages/orchestrator/src/routes/jobs.ts:135`  
**Impact:**
- **Extensions page** visible to all roles; `GET /extension-approvals` requires **admin** → operators/viewers get 403.
- **Dead letter page** visible to all roles; `GET /dead-letter` requires **operator** → viewers get 403.

Pages receive `role` prop but do not gate navigation or handle 403 gracefully (no `.catch()` on most pages).

---

### H-08 — Firecracker launcher is a stub

**Location:** `packages/sandbox-service/scripts/firecracker-launcher.sh:34–35`  
**Impact:** Production validation requires `FIRECRACKER_SOCKET` + `FIRECRACKER_LAUNCHER`, but launcher prints JSON success without spawning microVMs. Health endpoint reports `firecrackerReady: true` when socket env is set.

---

### H-09 — E006 Godot version check uses substring match

**Location:** `.github/workflows/godot_worker.yml:69`  
**Impact:** `grep -F "${GODOT_VERSION}"` matches `4.3.1` inside `4.3.10`. No exact semver comparison.

---

### H-10 — Export templates not validated in E006 step

**Location:** `workers/scripts/setup-godot.sh:75–92`, `godot_worker.yml:65–76`  
**Impact:** Templates are downloaded but E006 verification only checks `godot --version`. Missing or mismatched export templates are not caught until export (if ever).

---

### H-11 — Ephemeral SSH private key not deleted after cross-machine commit

**Location:** `workers/scripts/atomic-commit.sh:74–76`  
**Impact:** Key written to `/tmp/pgos-ssh-key-${JOB_ID}` with mode 600 but never removed in trap/cleanup.

---

### H-12 — Parity canary swallows Godot reimport failures

**Location:** `workers/scripts/parity-canary.sh:20`  
**Impact:** `godot ... || true` allows checksum generation even when reimport failed, producing false parity matches or misses.

---

### H-13 — Tier A absence causes false E010 parity failures

**Location:** `.github/workflows/parity_canary.yml:47–62`  
**Impact:** When Tier A self-hosted runner is unavailable, compare uses `missing-a` artifact vs real Tier B checksum, reporting parity failure rather than skipping with "Tier A unavailable."

---

### H-14 — Dead-letter BullMQ consumer is a stub

**Location:** `packages/orchestrator/src/workers/health-worker.ts:70–76`  
**Impact:** `pgos-dead-letter` worker only logs and beats cron heartbeat. No remediation, notification enrichment, or operator workflow beyond hourly `escalateDeadLetters` alerts.

---

## 4. Medium-Severity Findings

### M-01 — README API docs mismatch: `PATCH /jobs/:id/status` role

**Location:** `README.md:93`, `packages/orchestrator/src/routes/jobs.ts:94`  
**Docs say:** callback/operator. **Code:** `requireExactRole('callback')` only.

---

### M-02 — E019 error code misused for invalid FSM transitions

**Location:** `packages/orchestrator/src/services/job-service.ts:395`  
**Impact:** E019 is documented as `SCRIPT_OVERRIDE_REQUIRES_ADMIN`. Invalid status transitions also return E019, confusing operators and error catalog deep links.

---

### M-03 — Dead-letter escalation does not email `admin_contacts`

**Location:** `packages/orchestrator/src/services/alert-service.ts:64–75`, `health-worker.ts:289–297`  
**Impact:** Project `admin_contacts` are loaded and included in alert body text only. `sendAlert` emails `ADMIN_EMAIL` (or webhook), not per-project contacts.

---

### M-04 — Tier B health probe is synthetic

**Location:** `packages/orchestrator/src/workers/health-worker.ts:330–337`  
**Impact:** Measures Redis + Postgres latency, not GitHub runner cold-start or Godot availability.

---

### M-05 — `heartbeat.sh` swallows all failures

**Location:** `workers/scripts/heartbeat.sh:8` — `curl ... || true`  
**Impact:** Auth or network errors are silent; worker continues while orchestrator may reclaim lock.

---

### M-06 — Worker status PATCH callbacks lack HTTP validation

**Location:** `run-generation.sh`, `atomic-commit.sh`, `post-commit-verify.sh`  
**Impact:** `curl` exit codes and HTTP status not checked on lifecycle PATCH calls.

---

### M-07 — `CALLBACK_TOKEN` written to `GITHUB_ENV` in plaintext

**Location:** `workers/scripts/resolve-secrets.sh:58`  
**Impact:** May appear in debug logs; not GitHub-masked unless added as a secret. `SSH_PRIVATE_KEY_PEM` is correctly omitted.

---

### M-08 — Railway deploys orchestrator only; sandbox is separate

**Location:** `railway.toml`  
**Impact:** No Railway service definition for `sandbox-service`. Production requires manual second deploy + `SANDBOX_SERVICE_URL` wiring.

---

### M-09 — Railway healthcheck uses `/health` not `/ready`

**Location:** `railway.toml:7`  
**Impact:** `/ready` checks DB + Redis connectivity (`app.ts`); `/health` may pass while dependencies are down.

---

### M-10 — `workers/README.md` incomplete

**Missing documentation for:** `heartbeat.sh`, `setup-godot.sh`, `parity-canary.sh`, `perf-profile.sh`, `mad-analyze.mjs`, `godot_health.yml`, `parity_canary.yml`, `nightly_perf.yml`, cross-machine requirements, `commit-agent-once` wrapper.

---

### M-11 — `validate_node_paths.gd` is orphaned

**Location:** `workers/scripts/validate_node_paths.gd`  
**Impact:** Not referenced by any workflow or shell script. `run-generation.sh` uses Python UID-only validation.

---

### M-12 — `perf-profile.sh` uses hardcoded memory placeholder

**Location:** `workers/scripts/perf-profile.sh:24` — `mem_mib.txt` always `64`  
**Impact:** Nightly perf workflow does not measure actual memory usage.

---

### M-13 — No `errors.test.ts` for catalog completeness

**Location:** `packages/shared/src/errors.ts`, `docs/errors/`  
**Impact:** E001–E020 are complete (20 codes, 20 docs) but not unit-tested for parity between catalog keys and doc files.

---

### M-14 — MCP server tests are minimal

**Location:** `packages/mcp-server/tests/mcp-tools.test.ts`  
**Impact:** Only asserts default `PGOS_BASE_URL`. No tool registration, schema, or `pgosFetch` error-path tests.

---

### M-15 — Sandbox service lacks production-validation and execute-path tests

**Location:** `packages/sandbox-service/tests/health.test.ts`  
**Impact:** `validateSandboxProductionEnv()` and `/v1/execute` timeout/network-deny behavior untested.

---

### M-16 — Commit-agent lacks integration tests

**Location:** `packages/commit-agent/cmd/agent/main_test.go`  
**Impact:** Sidecar JSON round-trip tested; no `doCommit` idempotency, replay rejection, or fencing HTTP mock tests.

---

### M-17 — FAILOVER reason never written to `lock_fencing_seq`

**Location:** `packages/orchestrator/src/services/lock-service.ts:72–88`  
**Impact:** Schema supports `FAILOVER` reason; rotation only updates `redis_instance_state`. Invalidation relies on `instance_id` mismatch (works) but audit trail is incomplete.

---

### M-18 — GitHub mock dispatch always reports success

**Location:** `packages/github-service.ts` (mock `getRunStatus`)  
**Impact:** Local E2E with `GITHUB_MOCK=true` cannot surface dispatch/run failures.

---

## 5. Low-Severity Findings

| ID | Finding | Location |
|----|---------|----------|
| L-01 | Heartbeat rejection returns generic 403, not E013 | `routes/jobs.ts:127–128` |
| L-02 | `resolve-secret` 404 has no error code | `routes/secrets.ts:22–24` |
| L-03 | `lint` script only runs on orchestrator | `package.json:23` |
| L-04 | Orchestrator test glob `src/**/*.test.ts` matches nothing (tests in `tests/`) | `orchestrator/package.json` |
| L-05 | Unused env vars in orchestrator: `REIMPORT_TIMEOUT_MS`, `REIMPORT_MAX_RETRIES`, `ORCHESTRATOR_CACHE_DIR` | `config/env.ts` |
| L-06 | `secret-service.resolve()` legacy path has no callers | `secret-service.ts` |
| L-07 | `date +%s%3N` in parity/perf scripts is GNU-only | `parity-canary.sh:6`, `perf-profile.sh` |
| L-08 | `godot_health.yml` comment says "~5m schedule" but cron is `*/30` | `godot_health.yml:2–3` |
| L-09 | WebSocket only on Jobs page; Overview/Tiers/Locks are poll-only | `dashboard/src/pages/` |
| L-10 | `createJob()` client omits `godotVersion`, `preferredTier`, `commitStrategy` | `dashboard/src/api/client.ts` |
| L-11 | No git repository initialized | Project root |
| L-12 | `resolve-secrets.sh` error path may log HTTP body | `resolve-secrets.sh:17` |

---

## 6. Informational — Verified Strengths

| Area | Assessment |
|------|------------|
| Error catalog E001–E020 | ✅ Complete in `packages/shared/src/errors.ts` and `docs/errors/` |
| MCP tools vs README | ✅ All 6 tools implemented: `list_projects`, `list_jobs`, `get_job`, `get_job_status`, `create_job`, `list_locks` |
| JWE secret dispatch | ✅ Callback embedded in JWE; `resolve-secret` accepts `{ jwe }` only |
| Lock fencing (Redis + Postgres) | ✅ Acquire/release/reclaim with Lua + ledger double-write |
| Token revocation | ✅ Redis set + Postgres `token_revocations` |
| Path traversal protection | ✅ `@vibrato/shared` `assertWithinBase` |
| Script override admin gate | ✅ `patchIntroducesScript` requires admin (E019) |
| Callback auth exact-role | ✅ `requireExactRole('callback')` on worker endpoints |
| Workflow mirrors | ✅ `godot_worker`, `godot_health`, `parity_canary`, `nightly_perf` synced |
| CI pipeline | ✅ typecheck, test, build, mirror verify, shellcheck, S3 smoke, Go tests |
| Commit-agent idempotent rename | ✅ Source-gone + target-exists returns "already committed" |
| Pending sidecar crash recovery | ✅ `.pgos-pending-commit` written before rename |
| Production env validation | ✅ RS256 JWT, JWE secret, sandbox token, GitHub creds enforced |
| Bootstrap admin re-validation | ✅ `index.ts:43` re-checks `adminExists` after DB probe |
| E002 reimport retry | ✅ `delays=(10 30)`, `max=2` in worker scripts matches `.env.example` |

---

## 7. Acceptance Criteria Mapping (README §103–117)

| Criterion | Verdict | Gap Summary |
|-----------|---------|-------------|
| Fencing under Redis failover | ⚠️ Mostly met | Instance rotation works; no `FAILOVER` ledger row |
| Cross-machine crash recovery | ❌ Partial | SSH provision unchecked; remote post-commit/rollback missing |
| Reimport retries | ✅ Workers | Orchestrator env vars unused (worker-side only) |
| UID concurrency | ✅ | Reservation advisory lock + row lock |
| Nightly UID reconcile | ❌ Partial | DB-only; no Godot file scan/rewrite |
| Extension sandbox | ⚠️ Partial | Proxy works; Firecracker stub; worker_thread in dev |
| Tier parity | ⚠️ Partial | Workflow exists; false positives when Tier A down or Godot fails silently |
| Dead-letter 24/72h | ⚠️ Partial | Hourly escalation alerts; no contact email; consumer stub |
| Token revocation | ✅ | Redis + Postgres |
| Path traversal | ✅ | Shared library |
| Script override admin | ✅ | Merge service threat model |

---

## 8. Test Coverage Assessment

### 8.1 Automated Test Inventory

| Package | Test files | Tests (this run) | Coverage focus |
|---------|------------|------------------|----------------|
| shared | 5 | 16 | job-status FSM, fencing, path-security, semver, stats |
| orchestrator | 13 | 31 | auth, fencing, jobs, merge threat, rate-limit, production-validation, resolve-secret |
| dashboard | 1 | 3 | Jobs page WebSocket filter logic |
| mcp-server | 1 | 1 | Config default only |
| sandbox-service | 1 | 2 | Backend name, memory math |
| commit-agent (Go) | 2 | (cached pass) | Paths, sidecar JSON |

**Total:** ~53 Node tests + Go tests.

### 8.2 Coverage Gaps (untested critical paths)

- End-to-end worker pipeline (resolve → generate → commit → verify)
- Cross-machine SSH + commit-agent fencing integration
- MCP tool invocation and error responses
- Sandbox `/v1/execute` with network deny and timeout kill
- Dashboard page RBAC and API error handling
- WebSocket hub subscribe/broadcast filtering
- UID file-scan reconcile
- Structural merge file operations
- `dependsOnJobId` enforcement
- `provisionPublicKey` failure handling

---

## 9. Security Posture

### 9.1 Strengths

- No hardcoded production secrets in worker scripts
- JWE-only dispatch (no plain callback in workflow inputs)
- Callback tokens: 5-minute TTL, job-scoped
- RS256 JWT required in production
- Rate limiting: Redis sliding window per principal
- Commit-agent: no shell execution, path traversal guards, bloom + nonce replay protection
- systemd hardening in `pgos-commit-agent.service`

### 9.2 Risks

| Risk | Severity | Mitigation needed |
|------|----------|-------------------|
| Heartbeat gap → lock reclaim during commit | Critical | Extend heartbeat scope |
| SSH key left in `/tmp` | High | Trap cleanup |
| `CALLBACK_TOKEN` in `GITHUB_ENV` | Medium | Mask or pass via env file with restricted logging |
| Fencing optional on commit-agent without `PGOS_REQUIRE_FENCING` | High | Default `PGOS_REQUIRE_FENCING=true` in production docs/systemd |
| Firecracker stub passes health in production config | High | Real launcher or fail health when stub detected |
| `secretJwe` visible in GitHub workflow run inputs | Low (by design) | Treat run history as sensitive |

---

## 10. Deployment & Operations Gaps

| Item | Issue |
|------|-------|
| `railway.toml` | Single service; sandbox not included |
| `docker-compose.yml` | Incomplete build; no commit-agent service |
| `.env.example` | References `./secrets/jwt-private.pem` — requires `scripts/generate-jwt-keys.sh` first |
| Git | Repository not initialized — no version control, branch protection, or CI trigger path |
| `node_modules/` | Present on disk (gitignored); expected for local dev |
| `dist/` | Build artifacts present locally (gitignored) |

---

## 11. API Surface Completeness

### 11.1 Documented vs implemented (README table)

All 10 documented endpoints exist. One auth mismatch (M-01). Additional undocumented endpoints include:

- `POST /auth/login`, `GET /auth/me`, token management
- `GET /jobs`, `GET /jobs/:id`, `GET /jobs/errors/search`
- `GET /dead-letter`, `POST /dead-letter/:jobId/retry`
- `GET /locks/:lockKey/history`, `POST /locks/validate-token`
- Full projects CRUD, baselines, UID commit/reconcile
- Extension policies, approvals, execute
- Admin: audit logs, parity, tiers, cron heartbeats, redis failover simulation
- Artifacts presign/upload
- Docs: `GET /docs/agents.md`, `GET /docs/errors/:code`

### 11.2 Dashboard API client gaps

Missing wrappers: `createProject`, `getJob`, `enableTier`, `lockHistory`, `auditLogs`, `listExtensions`, `uidReserve`.

---

## 12. Prioritized Remediation Roadmap

### P0 — Blockers for production cross-machine flow

1. Extend heartbeat through commit + post-commit (C-01)
2. Implement remote post-commit verify + rollback (C-02, C-03)
3. Ship and document `commit-agent-once` wrapper (C-04)
4. Propagate per-job `PGOS_LOCK_OWNER` to remote agent (C-05)
5. Check `provisionPublicKey()` result before dispatch (C-06)

### P1 — Acceptance criteria completion

6. Enforce `dependsOnJobId` at create/dispatch (H-01)
7. Implement structural merge or document as override registry only (H-02)
8. Extend UID reconcile with file scan + Godot rewrite (H-03)
9. Add `mcp-server` to root build (H-04)
10. Fix docker-compose full build (H-05)
11. Add Projects page + fix dashboard RBAC (H-06, H-07)
12. Replace Firecracker stub or gate production on real hypervisor (H-08)

### P2 — Reliability & observability

13. Harden E006 version + template validation (H-09, H-10)
14. Fix parity canary false positives (H-12, H-13)
15. Flesh out dead-letter consumer + email `admin_contacts` (H-14, M-03)
16. Fix E019 misuse for FSM errors (M-02)
17. Update `workers/README.md` (M-10)

### P3 — Quality & hygiene

18. Expand test coverage (MCP, sandbox, commit-agent integration, shared errors)
19. Initialize git repository and enable CI on push
20. Add `build:mcp` script alias; extend lint to all TS packages
21. Remove or wire `validate_node_paths.gd`

---

## 13. Files Referenced

```
C:\Users\makem\Desktop\VMCP\package.json
C:\Users\makem\Desktop\VMCP\docker-compose.yml
C:\Users\makem\Desktop\VMCP\railway.toml
C:\Users\makem\Desktop\VMCP\.github\workflows\godot_worker.yml
C:\Users\makem\Desktop\VMCP\workers\scripts\atomic-commit.sh
C:\Users\makem\Desktop\VMCP\workers\scripts\post-commit-verify.sh
C:\Users\makem\Desktop\VMCP\workers\scripts\heartbeat.sh
C:\Users\makem\Desktop\VMCP\workers\scripts\resolve-secrets.sh
C:\Users\makem\Desktop\VMCP\workers\scripts\parity-canary.sh
C:\Users\makem\Desktop\VMCP\packages\orchestrator\src\services\job-service.ts
C:\Users\makem\Desktop\VMCP\packages\orchestrator\src\services\merge-service.ts
C:\Users\makem\Desktop\VMCP\packages\orchestrator\src\services\uid-service.ts
C:\Users\makem\Desktop\VMCP\packages\orchestrator\src\workers\health-worker.ts
C:\Users\makem\Desktop\VMCP\packages\orchestrator\src\routes\jobs.ts
C:\Users\makem\Desktop\VMCP\packages\dashboard\src\App.tsx
C:\Users\makem\Desktop\VMCP\packages\mcp-server\src\index.ts
C:\Users\makem\Desktop\VMCP\packages\sandbox-service\scripts\firecracker-launcher.sh
C:\Users\makem\Desktop\VMCP\packages\commit-agent\cmd\agent\main.go
C:\Users\makem\Desktop\VMCP\packages\shared\src\errors.ts
C:\Users\makem\Desktop\VMCP\docs\errors\E001.md … E020.md
```

---

## 14. Conclusion

VMCP is a **substantial, thoughtfully designed** orchestration platform with strong security primitives and excellent orchestrator-level test coverage. The architecture correctly separates concerns (orchestrator vs workers vs commit-agent vs sandbox).

The project is **not yet production-complete** for its full documented scope, particularly:

- **Cross-machine commit pipelines** (critical path gaps)
- **Structural merge and UID file reconciliation** (documented but stubbed)
- **Operator dashboard** (missing project management, RBAC mismatches)
- **Sandbox hardening** (Firecracker placeholder)
- **Repository hygiene** (no git init)

Addressing the P0 items alone would unblock the highest-risk production failure modes. P1 items align implementation with README/AGENTS acceptance criteria. P2–P3 improve operability, test confidence, and developer experience.

---

*End of report.*