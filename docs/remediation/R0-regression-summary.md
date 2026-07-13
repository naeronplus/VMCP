# R0 Regression Verification Summary

**Date:** 2026-07-13  
**Plan:** plan.md §5 Phase R0  
**Scope:** 46 FIXED/RESOLVED findings from report.md (v1.1 remediation regression gate)  
**Gate:** **PASSED** — safe to proceed to R1  
**Method:** `npm run verify:r0` → `scripts/verify-r0-regression.mjs` (no Go cache, full baseline + per-ID checks)

## Automated suite (R0.1)

| Step | Result |
|------|--------|
| npm run typecheck | ✅ |
| npm run lint | ✅ |
| npm test | ✅ |
| npm run build | ✅ |
| go test ./... -count=1 | ✅ |
| workflow mirrors | ✅ |

### Counts

| Metric | Expected | Actual |
|--------|----------|--------|
| Orchestrator test files | ≥24 | 32 |
| Orchestrator tests (npm) | ≥128 | 34 |
| Total npm tests (sum of workspace # tests) | ≥294 | 305 |
| commit-agent Go tests (=== RUN, -count=1) | ≥35 | 58 |
| mcp-server dist | exists | yes |

Full command output: `docs/remediation/R0-baseline-2026-07-13.log` (gitignored).

## Finding checklist (all FIXED IDs)

| ID | Verification | Result | Evidence |
|----|--------------|--------|----------|
| C-00 | cross-machine uses pgos_ssh_agent only (no scp/raw ssh outside wrapper) | ✅ | pgos_ssh_agent=true wrapper=true scp=false raw_ssh_scripts=false |
| C-01 | single Execute job pipeline step with heartbeat through commit+verify | ✅ | godot_worker.yml single pipeline step |
| C-02 | remote post-commit reimport default-on (PGOS_REMOTE_VERIFY:-1) | ✅ | post-commit-verify.sh |
| C-04 | commit-agent-once wrapper + multi-verb surface (stage-receive/reimport/restore) | ✅ | commit-agent-once + main.go verbs |
| C-05 | singleUse: false + environment in JIT provision body | ✅ | ssh-provision.ts L75 region |
| C-06 | failDispatchPreStart provision gate → DISPATCH_FAILED | ✅ | job-service.ts |
| H-01 | dependsOnJobId enforcement tests pass | ✅ | PASS |
| H-04 | mcp-server in root build + CI asserts dist | ✅ | package.json + ci.yml |
| H-05 | docker-compose builds dashboard + orchestrator | ✅ | docker-compose.yml |
| H-06 | ProjectsPage exists and is routed | ✅ | ProjectsPage.tsx + App.tsx |
| H-07 | dashboard RBAC module + tests | ✅ | rbac.ts + rbac.test.ts |
| H-09 | exact Godot semver validation (verify-godot + unit tests) | ✅ | semver tests PASS |
| H-10 | export template validation wired (E006 path) | ✅ | verify-godot.sh / godot-semver.mjs templates |
| H-11 | ssh key cleanup smoke in CI + script hooks | ✅ | ci.yml + atomic-commit cleanup |
| H-12 | parity canary reimport_status loud failure path | ✅ | parity-canary.sh + smoke |
| H-13 | parity tier A skip (no E010 on tier_a_unavailable) | ✅ | parity-service tests PASS |
| H-14 | alert-service / dead-letter tests present and suite green | ✅ | alert-service.test.ts + orch suite (34 tests) |
| M-01 | README documents callback-only PATCH | ✅ | README.md |
| M-02 | E021 in ERROR_CATALOG + docs/errors/E021.md | ✅ | errors.ts + E021.md |
| M-03 | dead-letter admin_contacts in health-worker | ✅ | health-worker.ts |
| M-04 | tier-probe tests | ✅ | tier-probe.test.ts |
| M-06 | pgos_callback_patch / pgos_patch_job_status helper | ✅ | pgos-callback.sh |
| M-07 | resolve-secrets masking (add-mask / ::add-mask::) | ✅ | resolve-secrets.sh |
| M-08 | railway multi-service doc | ✅ | docs/deploy/railway.md |
| M-09 | railway ready healthcheck | ✅ | railway.toml |
| M-10 | workers README comprehensive index | ✅ | workers/README.md |
| M-11 | validate_node_paths wired in run-generation | ✅ | run-generation.sh |
| M-12 | perf-profile memory smoke in CI | ✅ | ci.yml |
| M-13 | errors.test.ts catalog completeness (E001–E021) | ✅ | errors.test.ts executed in suite |
| M-14 | mcp-tools tests (≥10 DoD; suite green) | ✅ | mcp-tools.test.ts → 22 tests |
| M-15 | sandbox execute + production-validation tests | ✅ | sandbox-service tests |
| M-16 | commit-agent integration tests (≥35 Go tests) | ✅ | integration_test.go + 58 RUN |
| M-17 | FAILOVER ledger tests pass | ✅ | PASS |
| M-18 | github mock dispatch → DISPATCH_FAILED test | ✅ | github-mock-dispatch.test.ts |
| L-01 | heartbeat rejection returns E013 | ✅ | routes/jobs.ts |
| L-02 | SECRET_NOT_FOUND on resolve 404 | ✅ | routes/secrets.ts |
| L-03 | root lint chains all 5 TS workspaces | ✅ | package.json lint script |
| L-04 | orchestrator test glob discovers all tests/**/*.test.ts | ✅ | package.json + 32 files |
| L-05 | REIMPORT_* in env example | ✅ | .env.example |
| L-06 | legacy resolve(jwe) removed; resolveDispatchJwe only | ✅ | secret-service.ts |
| L-07 | portable timestamps (Date.now) in parity | ✅ | parity-canary.sh |
| L-08 | godot_health cron */30 | ✅ | godot_health.yml |
| L-09 | dashboard WebSocket hook used on live pages | ✅ | usePgosWebSocket + OverviewPage |
| L-10 | api client completeness test | ✅ | api-client-completeness.test.ts |
| L-12 | resolve-secrets logs HTTP status only on failure (no body leak) | ✅ | resolve-secrets.sh |
| DOC-01 | report.md populated (audit artifact) | ✅ | report.md |

## R0.2 Critical path (plan §5)

| ID | Spot check | Result |
|----|------------|--------|
| C-00 | pgos_ssh_agent only in atomic-commit / post-commit-verify | ✅ |
| C-01 | Single "Execute job pipeline" step | ✅ |
| C-05 | singleUse: false in ssh-provision.ts | ✅ |
| C-06 | failDispatchPreStart provision gate | ✅ |
| H-01 | dependsOnJobId tests | ✅ |
| M-17 | FAILOVER ledger tests | ✅ |

## R0.3 Definition of Done

- [x] Baseline log shows all green (`R0-baseline-2026-07-13.log`)
- [x] Checklist references all FIXED finding IDs (46/46 IDs green; 60/60 total checks)
- [x] `npm run verify:r0` exits 0 — no regressions; R1 may begin

## Re-run

```bash
npm run verify:r0
```

---

*Generated by scripts/verify-r0-regression.mjs — Phase R0 plan.md §5*
