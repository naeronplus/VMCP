# Cross-machine E2E gate (TEST-01 / plan §11.1)

Signed evidence for production cross-machine readiness. This runbook covers **seven scenarios** on real infrastructure (Tier A `godot-worker` runner + Godot target host) and the **automated smoke path** used for CI and `npm run verify:r6`.

## Prerequisites (§11.1.1)

| Component | Requirement |
|-----------|-------------|
| Orchestrator | Railway or `docker compose up` with Postgres, Redis, MinIO/S3 |
| Tier A runner | Self-hosted label `godot-worker` |
| Target host | `commit-agent` + `target-provisioner` + Godot **exact** version match |
| GitHub secrets | `PGOS_BASE_URL`, `PGOS_ADMIN_TOKEN`, S3, GitHub App credentials |
| Target metadata | `metadata.targetHost`, `metadata.targetProvisionUrl` on project |

Install on target (DEP-02):

```bash
bash packages/commit-agent/scripts/install.sh
# provisioner: see packages/target-provisioner/README.md
```

## Seven scenarios (§11.1.2)

| # | Scenario | Expected | Automated validator |
|---|----------|----------|---------------------|
| 1 | Create project with `targetHost` + `targetProvisionUrl` | JIT key in `authorized_keys.d` | `ssh-provision-integration.test.ts` + live API (workflow) |
| 2 | Happy path generation | `COMPLETED`; heartbeat throughout | `pgos-remote-protocol-smoke.sh`, `heartbeat-lifecycle-smoke.sh` |
| 3 | Provision failure (bad URL) | `DISPATCH_FAILED`; no SSH in JWE | `provision-dispatch.test.ts`, provision 401 integration |
| 4 | Wrong fencing owner | `COMMIT_FAILED` / E013 | `go test` fencing reject (`TestDoCommit_FencingViaHTTPMock_AcceptsAndRejects`) |
| 5 | Post-commit reimport fail | `ROLLBACK`; S3 snapshot restores target | `snapshot-rollback-smoke.sh` |
| 6 | Host backup only (S3 disabled) | Restore from `target.bak-{jobId}` | `host-backup-rollback-smoke.sh` |
| 7 | Editor lock on target | E012 or wait then succeed | `editor-lock-cross-machine-smoke.sh` |

## Execution modes

### Automated (default — `npm run verify:r6`)

Runs scenario validators above (real worker scripts + Go/TS tests). Writes redacted evidence:

- `docs/e2e/cross-machine-e2e-<date>.log`
- `docs/e2e/cross-machine-e2e-summary.md`

### Live (operator — Tier A + target)

1. Configure secrets per `workers/README.md`.
2. Trigger GitHub Actions **Cross-machine E2E** (`e2e_cross_machine.yml` → `workflow_dispatch`).
3. Or run locally:

```bash
export PGOS_BASE_URL='https://your-orchestrator.example'
export PGOS_ADMIN_TOKEN='<redacted>'
export E2E_PROJECT_ID='<uuid>'
export E2E_TARGET_HOST='user@target.example'
export E2E_TARGET_PROVISION_URL='https://target:9071/v1/provision'
node scripts/run-cross-machine-e2e.mjs --mode live
```

Append live output to the dated log; re-run `npm run verify:r6`.

## Redaction rules (§11.1.3.1)

Before committing logs, redact:

- Bearer tokens, JWE payloads, `CALLBACK_TOKEN`, SSH private keys
- `PGOS_ADMIN_TOKEN`, `PGOS_PROVISION_TOKEN`, S3 secret keys
- Presigned URLs (replace host + query with `[REDACTED]`)

Use `scripts/run-cross-machine-e2e.mjs` — it applies redaction automatically.

## Sign-off

| Field | Value |
|-------|-------|
| Date | |
| Operator | |
| Orchestrator URL | |
| Runner label | `godot-worker` |
| Target host | |
| Godot version | |
| Scenarios 1–7 | PASS / FAIL |
| Evidence log | `docs/e2e/cross-machine-e2e-<date>.log` |

## Related

- `workers/README.md` — worker secrets, verbs, CI smokes
- `docs/deploy/railway.md` — orchestrator deploy
- `docs/deploy/git-hosting.md` — CI + branch protection
- `plan.md` §11 — Phase R6 Definition of Done