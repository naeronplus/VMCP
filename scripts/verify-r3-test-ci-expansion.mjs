#!/usr/bin/env node
/**
 * Phase R3 — Test & CI Expansion (plan.md §8)
 *
 * TEST-03: 9/9 worker bash smokes wired in ci.yml
 * TEST-02: ws-hub mayReceiveJobEvent unit tests (≥6)
 *
 * No shortcuts:
 *   - orchestrator ws-hub.test.ts
 *   - all 9 worker bash smokes (Git Bash on Windows)
 *   - static contract checks for ci.yml + ws-hub exports
 *
 * Writes:
 *   docs/remediation/R3-baseline-<date>.log  (gitignored via *.log)
 *   docs/remediation/R3-regression-summary.md (committed)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R3-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R3-regression-summary.md');

const R3_FINDING_IDS = ['TEST-02', 'TEST-03'];

/** Plan §8.1 + §12: 9 bash worker smokes in CI order. */
const WORKER_SMOKES = [
  'workers/tests/pgos-s3-smoke.sh',
  'workers/tests/ssh-key-cleanup-smoke.sh',
  'workers/tests/validate-node-paths-smoke.sh',
  'workers/tests/perf-profile-smoke.sh',
  'workers/tests/pgos-callback-smoke.sh',
  'workers/tests/heartbeat-lifecycle-smoke.sh',
  'workers/tests/pgos-remote-protocol-smoke.sh',
  'workers/tests/parity-canary-smoke.sh',
  'workers/tests/resolve-secrets-mask-smoke.sh',
];

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

const SMOKE_TIMEOUT_SEC = 120;

function bashScript(rel) {
  const bash =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : 'bash';
  if (process.platform === 'win32' && !existsSync(bash)) {
    return { ok: false, status: 127, out: 'Git Bash not found' };
  }
  const script = join(root, rel).replace(/\\/g, '/');
  // timeout prevents spawnSync hangs when Git Bash leaves background node jobs
  return run(
    bash,
    ['-c', `timeout ${SMOKE_TIMEOUT_SEC} bash "${script}"`],
    { shell: false },
  );
}

mkdirSync(join(root, 'docs', 'remediation'), { recursive: true });

// ── R3.1 TEST-02: ws-hub tests ─────────────────────────────────────

const wsHubTests = run(
  'node',
  ['--import', 'tsx', '--test', 'tests/ws-hub.test.ts'],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('ws-hub.test.ts', wsHubTests.out || `(exit ${wsHubTests.status})`);
record(
  'TEST-02',
  'ws-hub.test.ts (≥6 mayReceiveJobEvent + subscribe tests)',
  wsHubTests.ok,
  wsHubTests.ok ? 'PASS' : `exit ${wsHubTests.status}`,
);

const wsHubSrc = read('packages/orchestrator/src/lib/ws-hub.ts');
record(
  'TEST-02',
  'mayReceiveJobEvent exported from ws-hub.ts',
  wsHubSrc.includes('export function mayReceiveJobEvent'),
  'ws-hub.ts',
);

record(
  'TEST-02',
  'handleWsClientMessage exported for subscribe filter',
  wsHubSrc.includes('export function handleWsClientMessage'),
  'ws-hub.ts',
);

record(
  'TEST-02',
  'extractProjectId exported (global vs scoped events)',
  wsHubSrc.includes('export function extractProjectId'),
  'ws-hub.ts',
);

record(
  'TEST-02',
  'WsHub mayReceive delegates to mayReceiveJobEvent',
  wsHubSrc.includes('return mayReceiveJobEvent(ctx, projectId)'),
  'ws-hub.ts',
);

record(
  'TEST-02',
  'createWsHub factory for isolated broadcast tests',
  wsHubSrc.includes('export function createWsHub') &&
    wsHubSrc.includes('export class WsHub'),
  'ws-hub.ts',
);

const wsHubTestFile = read('packages/orchestrator/tests/ws-hub.test.ts');
const wsHubTestCount = (wsHubTestFile.match(/\bit\(/g) ?? []).length;
record(
  'TEST-02',
  `ws-hub.test.ts has ≥6 test cases (found ${wsHubTestCount})`,
  wsHubTestCount >= 6,
  `${wsHubTestCount} it() blocks`,
);

record(
  'TEST-02',
  'ws-hub.test.ts covers broadcast + subscribe socket path',
  wsHubTestFile.includes('createWsHub') &&
    wsHubTestFile.includes('broadcast') &&
    wsHubTestFile.includes('clientMessage'),
  'broadcast + subscribe integration',
);

// ── R3.2 TEST-03: worker smokes ────────────────────────────────────

let smokesPassed = 0;
for (const script of WORKER_SMOKES) {
  console.log(`[verify:r3] smoke ${smokesPassed + 1}/${WORKER_SMOKES.length}: ${script}`);
  const r = bashScript(script);
  append(script, r.out || `(exit ${r.status})`);
  const ok = r.ok;
  if (ok) smokesPassed++;
  record(
    'TEST-03',
    script,
    ok,
    ok ? 'PASS' : `exit ${r.status}`,
  );
}

record(
  'TEST-03',
  `9/9 worker bash smokes green (${smokesPassed}/9)`,
  smokesPassed === 9,
  `${smokesPassed}/9 passed`,
);

// ── R3.3 CI wiring static checks ───────────────────────────────────

const ciYml = read('.github/workflows/ci.yml');
const workersReadme = read('workers/README.md');

const ciHasWorkerSmokesJob =
  /worker-smokes\s*:/.test(ciYml) &&
  (ciYml.includes('Worker smokes (TEST-03)') || ciYml.includes('TEST-03'));
const ciHasAllNine = WORKER_SMOKES.every((s) => {
  // CI steps reference paths as workers/tests/...
  return ciYml.includes(s) || ciYml.includes(s.replace(/^workers\//, ''));
});
record(
  'TEST-03',
  'ci.yml worker-smokes job runs all 9 bash scripts',
  ciHasWorkerSmokesJob && ciHasAllNine,
  ciHasWorkerSmokesJob
    ? ciHasAllNine
      ? 'ci.yml references'
      : 'missing smoke path in ci.yml'
    : 'missing worker-smokes job',
);

record(
  'TEST-03',
  'ci.yml labels TEST-03 / 9/9 smokes',
  ciYml.includes('TEST-03') &&
    (ciYml.includes('[9/9]') || ciYml.includes('9/9')),
  'ci.yml job name/steps',
);

const readmeListsAllSmokes = WORKER_SMOKES.every((s) => {
  const base = s.split('/').pop() ?? s;
  return workersReadme.includes(base);
});
record(
  'TEST-03',
  'workers/README documents CI worker-smokes section',
  workersReadme.includes('TEST-03') &&
    workersReadme.includes('worker-smokes') &&
    workersReadme.includes('9/9') &&
    readmeListsAllSmokes,
  readmeListsAllSmokes ? 'workers/README.md' : 'README missing smoke script name',
);

record(
  'TEST-03',
  'verify:r3 script registered in package.json',
  read('package.json').includes('verify:r3'),
  'package.json',
);

record(
  'TEST-03',
  'reap-background.sh helper for spawnSync-safe mock servers',
  existsSync(join(root, 'workers/tests/lib/reap-background.sh')) &&
    read('workers/tests/heartbeat-lifecycle-smoke.sh').includes('reap-background.sh'),
  'workers/tests/lib/reap-background.sh',
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R3_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R3_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R3 Test & CI Expansion — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §8 Phase R3  
**Scope:** TEST-02 (ws-hub tests) + TEST-03 (9/9 worker CI smokes)  
**Gate:** ${failed === 0 ? '**PASSED** — safe to proceed to R4' : '**FAILED** — fix blockers before R4'}  
**Method:** \`npm run verify:r3\` → \`scripts/verify-r3-test-ci-expansion.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## Automated suite

| Step | Result |
|------|--------|
| ws-hub.test.ts | ${checks.find((c) => c.desc.includes('ws-hub.test.ts (≥6'))?.ok ? '✅' : '❌'} |
| 9/9 worker bash smokes | ${checks.find((c) => c.desc.includes('9/9 worker bash smokes green'))?.ok ? '✅' : '❌'} (${smokesPassed}/9) |
| ci.yml TEST-03 wiring | ${checks.find((c) => c.desc.includes('ci.yml worker-smokes'))?.ok ? '✅' : '❌'} |

Full command output: \`docs/remediation/R3-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R3 Definition of Done (plan §8.1 + §8.2)

- [${checks.find((c) => c.desc.includes('9/9 worker bash smokes green'))?.ok ? 'x' : ' '}] TEST-03: CI runs 9/9 worker smoke scripts
- [${checks.find((c) => c.desc.includes('workers/README documents'))?.ok ? 'x' : ' '}] TEST-03: workers/README CI section
- [${checks.find((c) => c.desc.includes('ws-hub.test.ts (≥6'))?.ok ? 'x' : ' '}] TEST-02: ≥6 ws-hub tests green
- [${checks.find((c) => c.desc.includes('mayReceiveJobEvent exported'))?.ok ? 'x' : ' '}] TEST-02: mayReceiveJobEvent exported
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r3\` exits 0

## Re-run

\`\`\`bash
npm run verify:r3
\`\`\`

---

*Generated by scripts/verify-r3-test-ci-expansion.mjs — Phase R3 plan.md §8*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R3 test & CI expansion verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  worker smokes: ${smokesPassed}/9`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}