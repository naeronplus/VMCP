# Cross-machine E2E gate (TEST-01 / plan §11.1)

Signed evidence for production cross-machine readiness. This runbook covers **eight automated scenarios** (seven cross-machine job paths + remote merge outbox) plus **live** operator checks on real infrastructure (Tier A `godot-worker` runner + Godot target host). Automated validators power CI and `npm run verify:r6`.

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

## Automated scenarios (§11.1.2 + plan §7.2)

| # | Scenario | Expected | Automated validator |
|---|----------|----------|---------------------|
| 1 | Create project with `targetHost` + `targetProvisionUrl` | JIT key in `authorized_keys.d` | `ssh-provision-integration.test.ts` + live API (workflow) |
| 2 | Happy path generation | `COMPLETED`; heartbeat throughout | `pgos-remote-protocol-smoke.sh`, `heartbeat-lifecycle-smoke.sh` |
| 3 | Provision failure (bad URL) | `DISPATCH_FAILED`; no SSH in JWE | `provision-dispatch.test.ts`, provision 401 integration |
| 4 | Wrong fencing owner | `COMMIT_FAILED` / E013 | `go test` fencing reject (`TestDoCommit_FencingViaHTTPMock_AcceptsAndRejects`) |
| 5 | Post-commit reimport fail | `ROLLBACK`; S3 snapshot restores target | `snapshot-rollback-smoke.sh` |
| 6 | Host backup only (S3 disabled) | Restore from `target.bak-{jobId}` | `host-backup-rollback-smoke.sh` |
| 7 | Editor lock on target | E012 or wait then succeed | `editor-lock-cross-machine-smoke.sh` |
| 8 | Remote merge outbox (H-02) | Envelope `secretJwe` → remote `merge-apply` → complete | `merge-outbox-e2e-smoke.sh` |

## Execution modes

### Automated (CI + local)

Runs scenario validators above (real worker scripts + Go/TS tests). Writes redacted evidence:

- `docs/e2e/cross-machine-e2e-<date>.log`
- `docs/e2e/cross-machine-e2e-summary.md`

### Live (mandatory for TEST-01 FIXED — plan §7.3)

Live is **required** for production sign-off. `npm run verify:r6` fails without a committed live evidence file containing the marker **`LIVE PASS`**.

## Mandatory live sign-off (plan §7.3)

### Secrets & configuration checklist

| Name | Where | Required | Purpose |
|------|--------|----------|---------|
| `PGOS_BASE_URL` | GitHub Actions secret / env | **Yes** | Orchestrator public URL |
| `PGOS_ADMIN_TOKEN` | GitHub Actions secret / env | **Yes** | Operator/admin JWT for live API |
| `PGOS_SERVICE_TOKEN` | GitHub Actions secret | Recommended | Merge-outbox complete callback (H-02 / ENV-02) |
| GitHub App / dispatch creds | Orchestrator env | **Yes** (for real jobs) | `workflow_dispatch` from orchestrator |
| `E2E_TARGET_HOST` | Actions var or env | Recommended | Target host for live project metadata |
| `E2E_TARGET_PROVISION_URL` | Actions var or env | Recommended | JIT provision URL on target |
| `E2E_GODOT_VERSION` | workflow input | Yes (default `4.3.1`) | Exact Godot semver on runner + target |
| Runner label | Org/repo runners | **Yes** | `self-hosted` + `godot-worker` |
| Target install | Target host | **Yes** | `commit-agent` + `target-provisioner` + matching Godot |

Workflow **fails closed** if `PGOS_BASE_URL` or `PGOS_ADMIN_TOKEN` is empty (no silent skip).

### How to run live

**Preferred — GitHub Actions** (default `runLiveApi=1`):

```bash
gh workflow run e2e_cross_machine.yml -f godotVersion=4.3.1 -f runLiveApi=1
```

**Local supplement:**

```bash
export PGOS_BASE_URL='https://your-orchestrator.example'
export PGOS_ADMIN_TOKEN='<redacted>'
export E2E_PROJECT_ID='<uuid>'           # optional
export E2E_TARGET_HOST='user@target.example'
export E2E_TARGET_PROVISION_URL='https://target:9071/v1/provision'
export E2E_GODOT_VERSION='4.3.1'
node scripts/run-cross-machine-e2e.mjs --mode live
```

### Evidence artifact (must commit)

| File | Content |
|------|---------|
| `docs/e2e/cross-machine-e2e-live-<date>.log` | Redacted live API output + line **`LIVE PASS`** |
| `docs/e2e/cross-machine-e2e-summary.md` | Updated with live row |

**Do not** commit a fabricated `LIVE PASS`. Attempt-only logs use suffix `-attempt.log` and do **not** satisfy the gate.

After a successful Actions run:

```bash
node scripts/fetch-live-e2e-evidence.mjs --run-id <github-run-id>
# or
node scripts/fetch-live-e2e-evidence.mjs --latest
```

Break-glass: set workflow input `runLiveApi=0` only for automated-only dry runs (does **not** satisfy `verify:r6` live gate).

### P2.4 status (2026-07-13)

Live dispatch was attempted (`run 29214678335`); job stayed **queued** (no online `godot-worker` / billing lock). See `cross-machine-e2e-live-2026-07-13-attempt.log` and summary.

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
| Scenarios 1–8 (automated) | PASS / FAIL |
| Live API supplement | PASS / FAIL |
| Live evidence | `docs/e2e/cross-machine-e2e-live-<date>.log` (`LIVE PASS`) |
| Automated log | `docs/e2e/cross-machine-e2e-<date>.log` |

## Related

- `workers/README.md` — worker secrets, verbs, CI smokes
- `docs/deploy/railway.md` — orchestrator deploy
- `docs/deploy/git-hosting.md` — CI + branch protection
- `plan.md` §11 — Phase R6 Definition of Done