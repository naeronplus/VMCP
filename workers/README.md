# PGOS Workers — GitHub Actions & Tier A Runners

## Overview

Workers execute Godot generation jobs dispatched by the orchestrator via `workflow_dispatch`. **Sensitive credentials never appear in workflow inputs** — only `secretJwe` is passed; callback tokens are embedded inside the JWE.

## Required GitHub Actions secrets

| Secret | Purpose |
|--------|---------|
| `PGOS_BASE_URL` | Orchestrator public URL (e.g. `https://pgos.example.com`) |
| `PGOS_ADMIN_TOKEN` | Admin JWT for `godot_health.yml` cron probes |
| `SLACK_WEBHOOK_URL` | Optional alert webhook for health failures |

## Tier B (GitHub-hosted)

Uses `ubuntu-latest`. No extra setup — workflows install Godot via `setup-godot.sh`.

## Tier A (self-hosted `godot-worker`)

1. Register a self-hosted runner with labels: `self-hosted`, `godot-worker`
2. Install Godot 4.3+ and export templates (or let `setup-godot.sh` handle it)
3. Create project directory root: `/var/godot/projects/` (writable by runner user)
4. For cross-machine commits, install `commit-agent` on target hosts:

```bash
cd packages/commit-agent
go build -o /usr/local/bin/commit-agent ./cmd/agent
```

Set on target host:
- `PGOS_AGENT_TOKEN` — operator+ API token
- `PGOS_REQUIRE_FENCING=true`
- `PGOS_URL` — orchestrator base URL

## Worker pipeline

1. `resolve-secrets.sh` — POST `/api/v1/resolve-secret` with dispatch JWE
2. `run-generation.sh` — S3 download/upload, reimport, validation
3. `atomic-commit.sh` — S3 snapshot, fenced commit
4. `post-commit-verify.sh` — post-commit reimport; S3 snapshot rollback

## Local script testing

```bash
export PGOS_BASE_URL=http://localhost:8080
export JOB_ID=<uuid>
export PROJECT_ID=<uuid>
export SECRET_JWE=<dispatch-jwe-from-job>
bash workers/scripts/resolve-secrets.sh
```