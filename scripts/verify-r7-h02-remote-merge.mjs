#!/usr/bin/env node
/**
 * Phase R7 — H-02 remote structural merge complete (plan.md §6.4 / v3.0)
 *
 * Gates:
 *   1. commit-agent main.go has merge-apply constant + handler
 *   2. merge_apply.yml has secretJwe + resolve-secrets.sh
 *   3. merge-outbox-worker.ts passes secretJwe on remote dispatch
 *   4. merge-apply-remote-smoke.sh exits 0
 *   5. merge-apply-verb-smoke.sh exits 0
 *   6. go test ./... -count=1 in commit-agent
 *
 * Writes:
 *   docs/remediation/R7-baseline-<date>.log  (gitignored via *.log)
 *   docs/remediation/R7-regression-summary.md (committed)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R7-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R7-regression-summary.md');

const R7_FINDING_IDS = ['H-02', 'H-02-MERGE-VERB', 'H-02-WORKFLOW-SSH'];

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
  let command = cmd;
  if (process.platform === 'win32' && cmd === 'go' && useShell === false) {
    // go.exe on PATH
    command = 'go';
  }
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 300_000,
  });
  const errText = r.error
    ? `\n[spawn error] ${r.error.message || String(r.error)}`
    : '';
  const out = [r.stdout ?? '', r.stderr ?? '', errText].filter(Boolean).join('\n');
  return { ok: r.status === 0 && !r.error, status: r.status ?? 1, out };
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

function bashScript(rel) {
  const bash =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : 'bash';
  if (process.platform === 'win32' && !existsSync(bash)) {
    return { ok: false, status: 127, out: 'Git Bash not found' };
  }
  const script = join(root, rel).replace(/\\/g, '/');
  return run(bash, [script], { shell: false, timeoutMs: 300_000 });
}

mkdirSync(join(root, 'docs', 'remediation'), { recursive: true });

// ── Static contracts ─────────────────────────────────────────────────

const mainGo = read('packages/commit-agent/cmd/agent/main.go');
record(
  'H-02-MERGE-VERB',
  'main.go: cmdMergeApply + merge-apply handler branch',
  includesAll(mainGo, [
    'cmdMergeApply',
    '"merge-apply"',
    'case cmdMergeApply',
    'handleMergeApply',
  ]) && existsSync(join(root, 'packages/commit-agent/cmd/agent/merge_apply.go')),
  'packages/commit-agent/cmd/agent/main.go + merge_apply.go',
);

const mergeYml = read('.github/workflows/merge_apply.yml');
const mergeYmlMirror = read('workers/.github/workflows/merge_apply.yml');
record(
  'H-02-WORKFLOW-SSH',
  'merge_apply.yml: secretJwe input + resolve-secrets.sh step',
  includesAll(mergeYml, [
    'secretJwe',
    'SECRET_JWE',
    'resolve-secrets.sh',
    'self-hosted, godot-worker',
    'merge-apply.sh',
  ]) && mergeYml === mergeYmlMirror,
  'merge_apply.yml root + workers mirror',
);

const worker = read('packages/orchestrator/src/workers/merge-outbox-worker.ts');
const dispatch = read(
  'packages/orchestrator/src/services/merge-outbox-dispatch.ts',
);
record(
  'H-02',
  'merge-outbox remote dispatch passes secretJwe (JWE only)',
  includesAll(worker, [
    'secretJwe',
    'buildMergeApplyDispatchEnvelope',
    'merge_apply.yml',
  ]) &&
    includesAll(dispatch, [
      'secretJwe',
      'createDirectDispatchJwe',
      'buildMergeApplyDispatchEnvelope',
    ]) &&
    existsSync(
      join(root, 'packages/orchestrator/src/services/merge-outbox-dispatch.ts'),
    ),
  'merge-outbox-worker.ts + merge-outbox-dispatch.ts',
);

const mergeApplySh = read('workers/scripts/merge-apply.sh');
record(
  'H-02-WORKFLOW-SSH',
  'merge-apply.sh: remote TARGET_HOST + pgos_ssh_agent_stdin + complete',
  includesAll(mergeApplySh, [
    'TARGET_HOST',
    'pgos_ssh_agent_stdin',
    'merge-apply',
    'merge-outbox',
    '/complete',
    'mergedHash',
  ]),
  'workers/scripts/merge-apply.sh',
);

// ── Smokes ───────────────────────────────────────────────────────────

const remoteSmoke = bashScript('workers/tests/merge-apply-remote-smoke.sh');
append('merge-apply-remote-smoke.sh', remoteSmoke.out || `(exit ${remoteSmoke.status})`);
record(
  'H-02-WORKFLOW-SSH',
  'merge-apply-remote-smoke.sh exits 0',
  remoteSmoke.ok,
  remoteSmoke.ok ? 'PASS' : `exit ${remoteSmoke.status}`,
);

const verbSmoke = bashScript('workers/tests/merge-apply-verb-smoke.sh');
append('merge-apply-verb-smoke.sh', verbSmoke.out || `(exit ${verbSmoke.status})`);
record(
  'H-02-MERGE-VERB',
  'merge-apply-verb-smoke.sh exits 0',
  verbSmoke.ok,
  verbSmoke.ok ? 'PASS' : `exit ${verbSmoke.status}`,
);

// ── go test commit-agent ─────────────────────────────────────────────

const goTest = run(
  'go',
  ['test', './...', '-count=1'],
  { cwd: join(root, 'packages', 'commit-agent'), shell: false, timeoutMs: 300_000 },
);
append('go test commit-agent', goTest.out || `(exit ${goTest.status})`);
record(
  'H-02-MERGE-VERB',
  'go test ./... -count=1 in commit-agent',
  goTest.ok,
  goTest.ok ? 'PASS' : `exit ${goTest.status}`,
);

// ── Orchestrator dispatch unit tests (envelope completeness) ─────────

const orchTests = run(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    'tests/merge-outbox-dispatch.test.ts',
    'tests/merge-outbox-worker.test.ts',
  ],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false, timeoutMs: 180_000 },
);
append('orchestrator merge-outbox tests', orchTests.out || `(exit ${orchTests.status})`);
record(
  'H-02',
  'merge-outbox-dispatch + merge-outbox-worker tests',
  orchTests.ok,
  orchTests.ok ? 'PASS' : `exit ${orchTests.status}`,
);

// ── Mirrors ──────────────────────────────────────────────────────────

const mirrors = run(process.execPath, [join(root, 'scripts/verify-workflow-mirrors.mjs')], {
  shell: false,
});
append('verify-workflow-mirrors', mirrors.out || `(exit ${mirrors.status})`);
record(
  'H-02-WORKFLOW-SSH',
  'workflow mirrors in sync',
  mirrors.ok,
  mirrors.ok ? 'PASS' : `exit ${mirrors.status}`,
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R7_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R7_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R7 H-02 Remote Merge — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §6.4 Phase P1 (v3.0)  
**Scope:** H-02 + H-02-MERGE-VERB + H-02-WORKFLOW-SSH  
**Gate:** ${failed === 0 ? '**PASSED**' : '**FAILED**'}  
**Method:** \`npm run verify:r7\` → \`scripts/verify-r7-h02-remote-merge.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

Full command output: \`docs/remediation/R7-baseline-${date}.log\` (gitignored).

## P1 Definition of Done (plan §6.6)

- [${checks.find((c) => c.desc.includes('cmdMergeApply'))?.ok ? 'x' : ' '}] merge-apply verb in commit-agent
- [${checks.find((c) => c.desc.includes('secretJwe input'))?.ok ? 'x' : ' '}] merge_apply.yml secretJwe + resolve-secrets
- [${checks.find((c) => c.desc.includes('passes secretJwe'))?.ok ? 'x' : ' '}] remote dispatch uses JWE only
- [${checks.find((c) => c.desc.includes('remote-smoke'))?.ok ? 'x' : ' '}] merge-apply-remote-smoke.sh
- [${checks.find((c) => c.desc.includes('verb-smoke'))?.ok ? 'x' : ' '}] merge-apply-verb-smoke.sh
- [${checks.find((c) => c.desc.includes('go test'))?.ok ? 'x' : ' '}] commit-agent go test green
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r7\` exits 0

## Re-run

\`\`\`bash
npm run verify:r7
\`\`\`

---

*Generated by scripts/verify-r7-h02-remote-merge.mjs — plan.md §6.4*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R7 H-02 remote merge verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}
