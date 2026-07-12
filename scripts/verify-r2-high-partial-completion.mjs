#!/usr/bin/env node
/**
 * Phase R2 — High Partial Completion (plan.md §7)
 *
 * H-02: merge outbox consumer (local apply + remote merge_apply.yml)
 * H-03: remote UID reconcile auto-dispatch (uid_reconcile.yml)
 * H-08: Firecracker Path B — worker_thread production policy
 *
 * No shortcuts:
 *   - orchestrator H-02/H-03 unit tests
 *   - sandbox-service H-08 production-validation + health tests
 *   - workflow mirror sync
 *   - static contract checks per plan §7.1–7.3
 *
 * Writes:
 *   docs/remediation/R2-baseline-<date>.log  (gitignored via *.log)
 *   docs/remediation/R2-regression-summary.md (committed)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R2-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R2-regression-summary.md');

const R2_FINDING_IDS = ['H-02', 'H-03', 'H-08'];

const log = [];
const checks = [];
let failed = 0;

function append(section, text) {
  log.push(`\n=== ${section} ===\n${text}\n`);
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  const useShell =
    opts.shell !== undefined ? opts.shell : process.platform === 'win32';
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = [r.stdout ?? '', r.stderr ?? ''].filter(Boolean).join('\n');
  return { ok: r.status === 0, status: r.status ?? 1, out };
}

function record(id, desc, ok, evidence) {
  checks.push({ id, desc, ok, evidence });
  if (!ok) failed++;
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function includesAll(haystack, needles) {
  return needles.every((n) => haystack.includes(n));
}

mkdirSync(join(root, 'docs', 'remediation'), { recursive: true });

// ── R2.1 Orchestrator tests (H-02 / H-03) ────────────────────────────

const orchTests = run(
  'node',
  [
    '--import',
    'tsx',
    '--test',
    'tests/merge-outbox-worker.test.ts',
    'tests/uid-remote-dispatch.test.ts',
    'tests/uid-file-reconcile.test.ts',
    'tests/uid-service.test.ts',
  ],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('orchestrator R2 tests', orchTests.out || `(exit ${orchTests.status})`);
record(
  'R2.1',
  'merge-outbox-worker + uid-remote-dispatch + uid-file-reconcile + uid-service tests',
  orchTests.ok,
  orchTests.ok ? 'PASS' : `exit ${orchTests.status}`,
);

// ── R2.2 Sandbox H-08 tests ────────────────────────────────────────

const sandboxTests = run(
  'node',
  [
    '--import',
    'tsx',
    '--test',
    'tests/production-validation.test.ts',
    'tests/health.test.ts',
  ],
  { cwd: join(root, 'packages', 'sandbox-service'), shell: false },
);
append('sandbox-service H-08 tests', sandboxTests.out || `(exit ${sandboxTests.status})`);
record(
  'R2.2',
  'production-validation + health (Path B worker_thread)',
  sandboxTests.ok,
  sandboxTests.ok ? 'PASS' : `exit ${sandboxTests.status}`,
);

// ── R2.3 Workflow mirrors ──────────────────────────────────────────

const mirrors = run('node', ['scripts/verify-workflow-mirrors.mjs'], { shell: false });
append('verify-workflow-mirrors', mirrors.out || `(exit ${mirrors.status})`);
record(
  'R2.3',
  'uid_reconcile.yml + merge_apply.yml mirrors in sync',
  mirrors.ok,
  mirrors.ok ? 'PASS' : `exit ${mirrors.status}`,
);

// ── R2.4 H-02 static contract checks ───────────────────────────────

const h02Paths = [
  'packages/orchestrator/src/workers/merge-outbox-worker.ts',
  'packages/orchestrator/src/services/merge-apply.ts',
  'packages/orchestrator/src/routes/merge.ts',
  'workers/scripts/merge-apply.sh',
  'workers/scripts/lib/tscn-merge.mjs',
  '.github/workflows/merge_apply.yml',
  'workers/.github/workflows/merge_apply.yml',
];

const h02FilesOk = h02Paths.every((p) => existsSync(join(root, p)));
record(
  'H-02',
  'merge outbox consumer + merge_apply workflow + host script',
  h02FilesOk,
  h02FilesOk ? 'all present' : 'missing files',
);

const mergeOutboxWorker = read('packages/orchestrator/src/workers/merge-outbox-worker.ts');
const healthWorker = read('packages/orchestrator/src/workers/health-worker.ts');
const queues = read('packages/orchestrator/src/workers/queues.ts');
const mergeApplySh = read('workers/scripts/merge-apply.sh');
const mergeRoute = read('packages/orchestrator/src/routes/merge.ts');
const mergeService = read('packages/orchestrator/src/services/merge-service.ts');
const agentsMd = read('AGENTS.md');
const workersReadme = read('workers/README.md');

record(
  'H-02',
  'BullMQ pgos-merge-outbox + 5m cron + startMergeOutboxWorker',
  includesAll(healthWorker, [
    'mergeOutboxQueue',
    'repeat-merge-outbox-drain',
    'startMergeOutboxWorker',
    'every: 5 * 60 * 1000',
  ]) && queues.includes("'pgos-merge-outbox'"),
  'health-worker.ts + queues.ts',
);

record(
  'H-02',
  'Local applyTscnToFilesystem + remote merge_apply.yml dispatch',
  includesAll(mergeOutboxWorker, [
    'applyTscnToFilesystem',
    'merge_apply.yml',
    'merge.outbox_applied',
    'merge.outbox_dispatched',
    'markApplied',
    'markFailed',
  ]),
  'merge-outbox-worker.ts',
);

record(
  'H-02',
  'merge-apply.sh: local tscn-merge + POST /merge-outbox/:id/complete',
  includesAll(mergeApplySh, [
    'tscn-merge.mjs',
    'merge-outbox',
    '/complete',
    'PATCH_GET_URL',
  ]),
  'merge-apply.sh',
);

record(
  'H-02',
  'POST /merge-outbox/:id/complete marks applied + overrides.merged_hash',
  includesAll(mergeRoute, [
    '/merge-outbox/:id/complete',
    "status = 'applied'",
    'merged_hash',
    'merge.outbox_applied',
  ]),
  'routes/merge.ts',
);

record(
  'H-02',
  'merge-service creates merge_outbox pending row when root unreadable',
  mergeService.includes("'pending'") &&
    mergeService.includes('merge_outbox') &&
    mergeService.includes('applyTscnToFilesystem'),
  'merge-service.ts',
);

record(
  'H-02',
  'AGENTS.md documents automatic outbox consumer (not manual)',
  agentsMd.includes('pgos-merge-outbox') &&
    agentsMd.includes('merge_apply.yml') &&
    agentsMd.includes('Not a manual outbox'),
  'AGENTS.md',
);

record(
  'H-02',
  'workers/README documents merge outbox auto-dispatch',
  workersReadme.includes('merge_outbox') &&
    workersReadme.includes('merge_apply.yml'),
  'workers/README.md',
);

// ── R2.5 H-03 static contract checks ───────────────────────────────

const h03Paths = [
  'packages/orchestrator/src/services/uid-remote-dispatch.ts',
  '.github/workflows/uid_reconcile.yml',
  'workers/.github/workflows/uid_reconcile.yml',
];

const h03FilesOk = h03Paths.every((p) => existsSync(join(root, p)));
record(
  'H-03',
  'uid-remote-dispatch + uid_reconcile.yml (root + workers mirror)',
  h03FilesOk,
  h03FilesOk ? 'all present' : 'missing files',
);

const uidRemote = read('packages/orchestrator/src/services/uid-remote-dispatch.ts');
const uidFileReconcile = read('packages/orchestrator/src/services/uid-file-reconcile.ts');
const uidService = read('packages/orchestrator/src/services/uid-service.ts');
const uidReconcileYml = read('.github/workflows/uid_reconcile.yml');

record(
  'H-03',
  'dispatchUidReconcile: S3 map + uid_reconcile.yml + audit remote_dispatched',
  includesAll(uidRemote, [
    'uid_reconcile.yml',
    'remote_dispatched',
    'uid.nightly_reconcile',
    'replacementsGetUrl',
    'E008',
  ]),
  'uid-remote-dispatch.ts',
);

record(
  'H-03',
  'unreadable project_root → dispatchUidReconcile in uid-file-reconcile',
  uidFileReconcile.includes('dispatchUidReconcile') &&
    uidFileReconcile.includes('remote_dispatched'),
  'uid-file-reconcile.ts',
);

record(
  'H-03',
  'uid-service autoResolveDuplicates wires reconcileProjectFilesAfterFix',
  uidService.includes('reconcileProjectFilesAfterFix') &&
    healthWorker.includes('nightlyUidReconcile'),
  'uid-service.ts + health-worker.ts',
);

record(
  'H-03',
  'uid_reconcile.yml: download map + run uid-reconcile.sh on Tier A',
  includesAll(uidReconcileYml, [
    'workflow_dispatch',
    'self-hosted, godot-worker',
    'replacementsGetUrl',
    'uid-reconcile.sh',
  ]),
  'uid_reconcile.yml',
);

record(
  'H-03',
  'workers/README documents automatic remote UID dispatch',
  workersReadme.includes('uid_reconcile.yml') &&
    workersReadme.includes('remote_dispatched'),
  'workers/README.md',
);

record(
  'H-03',
  'uid-service.test.ts present (plan §7.2.3)',
  existsSync(join(root, 'packages/orchestrator/tests/uid-service.test.ts')),
  'uid-service.test.ts',
);

// ── R2.6 H-08 static contract checks ───────────────────────────────

const prodValidation = read('packages/sandbox-service/src/production-validation.ts');
const railwayMd = read('docs/deploy/railway.md');
const readme = read('README.md');
const sandboxApp = read('packages/sandbox-service/src/sandbox-app.ts');

record(
  'H-08',
  'SANDBOX_BACKEND=worker_thread documented production default in railway.md',
  railwayMd.includes('SANDBOX_BACKEND=worker_thread') &&
    railwayMd.includes('H-08 Path B') &&
    railwayMd.includes('worker_thread only (default)'),
  'docs/deploy/railway.md',
);

record(
  'H-08',
  'production-validation: worker_thread does not require FIRECRACKER_*',
  includesAll(prodValidation, [
    'isWorkerThreadBackend',
    'resolveSandboxBackendName',
    "return 'worker_thread'",
    'worker_thread policy',
  ]),
  'production-validation.ts',
);

record(
  'H-08',
  'health: stub/worker_thread never advertises firecrackerReady: true',
  prodValidation.includes('firecrackerReady: false') &&
    prodValidation.includes('worker_thread_only') &&
    !/firecrackerReady:\s*true[\s\S]{0,80}stub/.test(prodValidation),
  'firecrackerHealth()',
);

record(
  'H-08',
  'sandbox /health exposes sandboxPolicy for operators',
  sandboxApp.includes('sandboxPolicy') && sandboxApp.includes('firecrackerReady'),
  'sandbox-app.ts',
);

record(
  'H-08',
  'README acceptance: worker_thread enclave or Firecracker real',
  readme.includes('SANDBOX_BACKEND=worker_thread') &&
    readme.includes('H-08'),
  'README.md',
);

record(
  'H-08',
  'Firecracker real deferred documented (FIRECRACKER_REAL_NOT_WIRED)',
  railwayMd.includes('deferred') || railwayMd.includes('FIRECRACKER_REAL_NOT_WIRED'),
  'railway.md deferral note',
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R2_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R2_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} contract + test checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R2 High Partial Completion — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §7 Phase R2  
**Scope:** H-02 (merge outbox consumer) + H-03 (remote UID dispatch) + H-08 (worker_thread policy)  
**Gate:** ${failed === 0 ? '**PASSED** — safe to proceed to R3' : '**FAILED** — fix blockers before R3'}  
**Method:** \`npm run verify:r2\` → \`scripts/verify-r2-high-partial-completion.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## Automated suite

| Step | Result |
|------|--------|
| orchestrator H-02/H-03 tests | ${checks.find((c) => c.desc.includes('merge-outbox-worker'))?.ok ? '✅' : '❌'} |
| sandbox-service H-08 tests | ${checks.find((c) => c.desc.includes('production-validation'))?.ok ? '✅' : '❌'} |
| verify-workflow-mirrors.mjs | ${checks.find((c) => c.desc.includes('mirrors'))?.ok ? '✅' : '❌'} |

Full command output: \`docs/remediation/R2-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R2 Definition of Done (plan §7.1.5 + §7.2.4 + §7.3.5)

- [${checks.find((c) => c.desc.includes('merge-outbox-worker'))?.ok ? 'x' : ' '}] H-02: outbox consumer local apply + remote merge_apply.yml dispatch
- [${checks.find((c) => c.desc.includes('merge.outbox_applied'))?.ok ? 'x' : ' '}] H-02: audit merge.outbox_applied / merge.outbox_dispatched
- [${checks.find((c) => c.desc.includes('uid_reconcile.yml'))?.ok ? 'x' : ' '}] H-03: nightly remote UID auto-dispatch via uid_reconcile.yml
- [${checks.find((c) => c.desc.includes('uid-service.test.ts'))?.ok ? 'x' : ' '}] H-03: uid-service.test.ts remote dispatch wiring
- [${checks.find((c) => c.desc.includes('worker_thread production default'))?.ok ? 'x' : ' '}] H-08: SANDBOX_BACKEND=worker_thread production default documented
- [${checks.find((c) => c.desc.includes('never advertises firecrackerReady'))?.ok ? 'x' : ' '}] H-08: stub never advertises firecrackerReady: true
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r2\` exits 0

## Re-run

\`\`\`bash
npm run verify:r2
\`\`\`

---

*Generated by scripts/verify-r2-high-partial-completion.mjs — Phase R2 plan.md §7*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R2 high partial completion verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}