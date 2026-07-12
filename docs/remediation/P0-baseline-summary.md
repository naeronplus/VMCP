# P0 baseline summary — GIT-UNCOMMITTED

**Date:** 2026-07-12  
**Branch:** `remediation/v3-report-2026-07-12`  
**HEAD before commit stack:** `ac5ef96` (H-11: harden ephemeral SSH key cleanup)  
**Plan:** plan.md v3.0 §5.1–5.2

## Dirty tree snapshot

| Metric | Value |
| --- | --- |
| `git status --short` line count | **170** |
| Git remote (`origin`) | not set (L-11 deferred to P0.3) |
| Session dirs excluded | `agent-tools/`, `mcps/`, `terminals/` (not part of product tree) |

## Baseline suite results

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npm test` | ✅ exit 0 (all workspaces) |
| `npm run build` | ✅ exit 0 |
| `packages/commit-agent` `go test ./... -count=1` | ✅ ok (cmd/agent, internal) |
| `packages/target-provisioner` `go test ./... -count=1` | ✅ ok (cmd/provisioner, internal) |
| `node scripts/verify-workflow-mirrors.mjs` | ✅ mirrors in sync |
| `npm run verify:r1` | ✅ 27/27 |
| `npm run verify:r2` | ✅ 24/24 |
| `npm run verify:r3` | ✅ 23/23 + worker smokes 9/9 |
| `npm run verify:r4` | ✅ 28/28 |
| `npm run verify:r5` | ✅ 21/21 (origin not set — expected) |

### npm test breakdown (workspace TAP totals)

| Workspace | Tests passed |
| --- | --- |
| `@vibrato/shared` | 34 |
| `@vibrato/orchestrator` | 186 |
| `@vibrato/mcp-server` | 22 |
| `@vibrato/sandbox-service` | 35 |
| `@vibrato/dashboard` | 17 |
| **Combined** | **294 pass, 0 fail** |

## Gate decision

**Proceed with P0.2 logical commit stack** (GIT-UNCOMMITTED).  
L-11 remote/branch protection remains a separate operator-facing step after the tree is committed.

## Notes

- `*.log` under `docs/remediation/` is gitignored; this summary is the committed record.
- No secrets (`BEGIN.*PRIVATE`) are intended in the commit set; placeholders remain only in `.env.example`.
