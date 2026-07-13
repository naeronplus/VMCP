# P5 Regression Verification Summary

**Date:** 2026-07-13  
**Plan:** plan.md §10 Phase P5  
**Scope:** Prove v2.0 + v3.0 implementation did not regress any FIXED finding  
**Gate:** **PASSED**

## Full matrix

| Script | Finding focus | Checks | Result |
|--------|---------------|--------|--------|
| `npm run verify:r0` | 44 FIXED + DOC-01 | 60/60 · 46/46 IDs | ✅ |
| `npm run verify:r1` | DEP-01, C-03 | 27/27 | ✅ |
| `npm run verify:r2` | H-02, H-03, H-08 | 27/27 | ✅ |
| `npm run verify:r3` | TEST-02, TEST-03 | 23/23 · 9/9 smokes | ✅ |
| `npm run verify:r4` | SEC-01/02, CM-LOCK-01, DEP-02/03/04, NODE-DRIFT, MINIO-HC | 35/35 | ✅ |
| `npm run verify:r5` | M-05, L-11, DOC-02 | 21/21 | ✅ |
| `npm run verify:r7` | H-02 remote merge | 9/9 | ✅ |

**Combined:** all listed gates exit 0.

## Spot checks (plan §10.2)

| ID | Spot check | Result |
|----|------------|--------|
| C-00 | No raw `scp ` in `workers/scripts/atomic-commit.sh` | ✅ |
| C-01 | Single "Execute job pipeline" in `godot_worker.yml` | ✅ |
| H-08 | `SANDBOX_BACKEND=worker_thread` in `docs/deploy/railway.md` | ✅ |
| M-17 | `fencing-failover-ledger.test.ts` FAILOVER suite | ✅ 7/7 |

## Artifacts

| Path | Role |
|------|------|
| `docs/remediation/R0-regression-summary.md` | FIXED ID checklist + P5 re-verification section |
| `docs/remediation/R{0-5,7}-baseline-2026-07-13.log` | Full command logs (gitignored `*.log`) |
| `docs/remediation/R{0-5,7}-regression-summary.md` | Per-gate committed summaries |

## Not in P5 scope

- `verify:r6` — full E2E + report closure (P6); still requires live `LIVE PASS` evidence and report.md regeneration
- TEST-01 live FIXED claim — blocked until operator live run (P2.4)

## Re-run

```bash
npm run verify:r0
npm run verify:r1
npm run verify:r2
npm run verify:r3
npm run verify:r4
npm run verify:r5
npm run verify:r7
```

---

*P5 complete — plan.md §10*
