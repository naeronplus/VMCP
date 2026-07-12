#!/usr/bin/env node
/**
 * Phase R6 — E2E Gate & Report Regeneration (plan.md §11)
 *
 * TEST-01: 7/7 cross-machine scenario validators + committed evidence
 * §11.2: full verification suite (§3.2 + TEST-03 smokes) + prior phase gates
 *
 * No shortcuts: real tests, real smokes, artifact contracts, report.md closure checks.
 *
 * Writes:
 *   docs/remediation/R6-baseline-<date>.log
 *   docs/remediation/R6-regression-summary.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R6-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R6-regression-summary.md');
const e2eDir = join(root, 'docs', 'e2e');

const log = [];
const checks = [];
let failed = 0;

/** Prior-phase gate scripts (invoke via node — avoid nested npm.cmd issues on Windows). */
const PHASE_SCRIPTS = {
  r0: 'scripts/verify-r0-regression.mjs',
  r1: 'scripts/verify-r1-critical-blockers.mjs',
  r2: 'scripts/verify-r2-high-partial-completion.mjs',
  r3: 'scripts/verify-r3-test-ci-expansion.mjs',
  r4: 'scripts/verify-r4-security-deployment.mjs',
  r5: 'scripts/verify-r5-medium-low-hygiene.mjs',
};

/** TEST-03 9/9 worker smokes (plan §8.1 / §11.2.1 / §12). */
const TEST03_SMOKES = [
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

function append(section, text) {
  log.push(`\n=== ${section} ===\n${text}\n`);
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  const useShell =
    opts.shell !== undefined ? opts.shell : process.platform === 'win32';
  // On Windows prefer npm.cmd when shell is off; with shell:true bare "npm" is fine
  let command = cmd;
  if (
    process.platform === 'win32' &&
    cmd === 'npm' &&
    useShell === false
  ) {
    command = 'npm.cmd';
  }
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 900_000,
  });
  const errText = r.error
    ? `\n[spawn error] ${r.error.message || String(r.error)}`
    : r.signal
      ? `\n[signal] ${r.signal}`
      : '';
  const out = [r.stdout ?? '', r.stderr ?? '', errText].filter(Boolean).join('\n');
  const ok = r.status === 0 && !r.error;
  return { ok, status: r.status ?? 1, out };
}

function record(id, desc, ok, evidence) {
  checks.push({ id, desc, ok, evidence });
  if (!ok) failed++;
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
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
mkdirSync(e2eDir, { recursive: true });

// ── R6.0: prior phase gates (plan dependency: R5 → R6) ───────────────

for (const [phase, script] of Object.entries(PHASE_SCRIPTS)) {
  const r = run(process.execPath, [join(root, script)], {
    shell: false,
    timeoutMs: 900_000,
  });
  append(`verify:${phase} (${script})`, r.out || `(exit ${r.status})`);
  record(
    'TEST-01',
    `verify:${phase} regression gate`,
    r.ok,
    r.ok ? 'PASS' : `exit ${r.status}`,
  );
}

// ── §3.2 final CI suite (plan §12) ───────────────────────────────────

const suite = [
  ['npm run typecheck', () => run('npm', ['run', 'typecheck'])],
  ['npm run lint', () => run('npm', ['run', 'lint'])],
  ['npm test', () => run('npm', ['test'], { timeoutMs: 600_000 })],
  ['npm run build', () => run('npm', ['run', 'build'], { timeoutMs: 300_000 })],
  [
    'go test commit-agent',
    () =>
      run('go', ['test', '-count=1', './...'], {
        cwd: join(root, 'packages', 'commit-agent'),
      }),
  ],
  [
    'go test target-provisioner',
    () =>
      run('go', ['test', '-count=1', './...'], {
        cwd: join(root, 'packages', 'target-provisioner'),
      }),
  ],
  [
    'verify-workflow-mirrors',
    () => run(process.execPath, [join(root, 'scripts/verify-workflow-mirrors.mjs')], { shell: false }),
  ],
];

for (const [name, fn] of suite) {
  const r = fn();
  append(name, r.out || `(exit ${r.status})`);
  record('TEST-01', `§3.2 ${name}`, r.ok, r.ok ? 'PASS' : `exit ${r.status}`);
}

// ── §11.2.1 TEST-03 smokes (explicit re-run, no shortcut via r3 alone) ─

let smokePass = 0;
for (const rel of TEST03_SMOKES) {
  const r = bashScript(rel);
  append(`TEST-03 ${rel}`, r.out || `(exit ${r.status})`);
  if (r.ok) smokePass++;
  record(
    'TEST-01',
    `TEST-03 smoke ${rel.split('/').pop()}`,
    r.ok,
    r.ok ? 'PASS' : `exit ${r.status}`,
  );
}
record(
  'TEST-01',
  'TEST-03 9/9 worker smokes',
  smokePass === TEST03_SMOKES.length,
  `${smokePass}/${TEST03_SMOKES.length}`,
);

// ── TEST-01: E2E driver (7 scenarios) ───────────────────────────────

record(
  'TEST-01',
  'docs/e2e/cross-machine-e2e.md runbook exists',
  existsSync(join(e2eDir, 'cross-machine-e2e.md')),
  'docs/e2e/cross-machine-e2e.md',
);

const e2eWfPath = join(root, '.github', 'workflows', 'e2e_cross_machine.yml');
const e2eWfOk =
  existsSync(e2eWfPath) &&
  read('.github/workflows/e2e_cross_machine.yml').includes('workflow_dispatch') &&
  read('.github/workflows/e2e_cross_machine.yml').includes('godot-worker') &&
  read('.github/workflows/e2e_cross_machine.yml').includes('run-cross-machine-e2e');
record(
  'TEST-01',
  'e2e_cross_machine.yml workflow_dispatch present',
  e2eWfOk,
  '.github/workflows/e2e_cross_machine.yml',
);

const e2eRun = run(process.execPath, [join(root, 'scripts/run-cross-machine-e2e.mjs')], {
  shell: false,
  timeoutMs: 600_000,
});
append('run-cross-machine-e2e.mjs', e2eRun.out || `(exit ${e2eRun.status})`);
record(
  'TEST-01',
  '7/7 cross-machine E2E scenario validators',
  e2eRun.ok,
  e2eRun.ok ? '7/7 PASS' : `exit ${e2eRun.status}`,
);

const e2eLog = join(e2eDir, `cross-machine-e2e-${date}.log`);
const e2eSummary = join(e2eDir, 'cross-machine-e2e-summary.md');
record(
  'TEST-01',
  'E2E evidence log committed path',
  existsSync(e2eLog),
  e2eLog,
);
record(
  'TEST-01',
  'E2E summary markdown 7/7 PASS',
  existsSync(e2eSummary) &&
    readFileSync(e2eSummary, 'utf8').includes('7/7 PASS'),
  'cross-machine-e2e-summary.md',
);

// Redaction guard — no raw bearer tokens / unre-dacted secrets in log
if (existsSync(e2eLog)) {
  const logText = readFileSync(e2eLog, 'utf8');
  const hasLeak =
    /Bearer\s+eyJ/i.test(logText) ||
    /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{20,}/i.test(logText) ||
    /PGOS_ADMIN_TOKEN=(?!\[REDACTED\])\S+/i.test(logText) ||
    /PGOS_PROVISION_TOKEN=(?!\[REDACTED\])\S+/i.test(logText) ||
    /CALLBACK_TOKEN=(?!\[REDACTED\])\S+/i.test(logText) ||
    /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(logText);
  record(
    'TEST-01',
    'E2E log secrets redacted',
    !hasLeak,
    hasLeak ? 'possible secret leak' : 'no bearer/JWT/key leaks',
  );
} else {
  record('TEST-01', 'E2E log secrets redacted', false, 'log missing');
}

// ── §11.2 report.md regeneration contracts ───────────────────────────

const report = read('report.md');
record(
  'TEST-01',
  'report.md TEST-01 marked FIXED',
  /TEST-01.*\*\*FIXED\*\*/.test(report) ||
    report.includes('TEST-01 — Cross-machine E2E — **FIXED**'),
  'report.md TEST-01 section',
);
record(
  'TEST-01',
  'report.md executive: 0 OPEN Critical',
  /OPEN Critical.*\*\*0\*\*/.test(report) ||
    report.includes('| **OPEN Critical** | **0** |'),
  'executive summary',
);
record(
  'TEST-01',
  'report.md executive: 0 OPEN High',
  /OPEN High.*\*\*0\*\*/.test(report) ||
    report.includes('| **OPEN High** | **0** |'),
  'executive summary',
);
record(
  'TEST-01',
  'report.md 51 findings tracked',
  report.includes('| **Total findings** | **51** |') &&
    report.includes('| **FIXED** | **51** |') &&
    (report.match(/\| [A-Z]+-\d+/g) ?? []).length >= 40,
  'finding index + executive totals',
);
record(
  'TEST-01',
  'report.md OPEN count zero',
  report.includes('| **OPEN** | **0** |') || report.includes('| **PARTIAL** | **0** |'),
  'executive OPEN/PARTIAL',
);

record(
  'TEST-01',
  'verify:r6 registered in package.json',
  read('package.json').includes('verify:r6') &&
    read('package.json').includes('e2e:cross-machine'),
  'package.json',
);

// CI wires TEST-01 scenario smokes
const ci = read('.github/workflows/ci.yml');
record(
  'TEST-01',
  'ci.yml runs host-backup-rollback-smoke',
  ci.includes('host-backup-rollback-smoke.sh'),
  'ci.yml',
);
record(
  'TEST-01',
  'ci.yml runs editor-lock-cross-machine-smoke',
  ci.includes('editor-lock-cross-machine-smoke.sh'),
  'ci.yml',
);
record(
  'TEST-01',
  'ci.yml runs snapshot-rollback-smoke (scenario 5)',
  ci.includes('snapshot-rollback-smoke.sh'),
  'ci.yml',
);

// Scenario smoke scripts on disk
for (const rel of [
  'workers/tests/snapshot-rollback-smoke.sh',
  'workers/tests/host-backup-rollback-smoke.sh',
  'workers/tests/editor-lock-cross-machine-smoke.sh',
]) {
  record(
    'TEST-01',
    `smoke script exists ${rel.split('/').pop()}`,
    existsSync(join(root, rel)),
    rel,
  );
}

// ── Write artifacts ─────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R6 E2E Gate & Report Regeneration — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §11 Phase R6  
**Scope:** TEST-01 cross-machine E2E + §11.2 report regeneration  
**Gate:** ${failed === 0 ? '**PASSED** — v2.0 remediation complete' : '**FAILED** — fix blockers'}  
**Method:** \`npm run verify:r6\` → \`scripts/verify-r6-e2e-gate.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
| TEST-01 | ${checks.filter((c) => c.id === 'TEST-01').length} checks | ${failed === 0 ? '✅' : '❌'} | ${passCount}/${checks.length} pass |

## E2E artifacts

| Artifact | Result |
|----------|--------|
| cross-machine-e2e.md | ${existsSync(join(e2eDir, 'cross-machine-e2e.md')) ? '✅' : '❌'} |
| cross-machine-e2e-${date}.log | ${existsSync(e2eLog) ? '✅' : '❌'} |
| cross-machine-e2e-summary.md | ${existsSync(e2eSummary) ? '✅' : '❌'} |
| e2e_cross_machine.yml | ${existsSync(e2eWfPath) ? '✅' : '❌'} |

Full command output: \`docs/remediation/R6-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R6 Definition of Done (plan §11)

- [${checks.find((c) => c.desc.includes('7/7 cross-machine'))?.ok ? 'x' : ' '}] TEST-01: 7/7 scenarios pass (automated validators)
- [${checks.find((c) => c.desc.includes('E2E evidence log'))?.ok ? 'x' : ' '}] Evidence committed (secrets redacted)
- [${checks.find((c) => c.desc.includes('TEST-01 marked FIXED'))?.ok ? 'x' : ' '}] TEST-01 closed in \`report.md\`
- [${checks.find((c) => c.desc.includes('0 OPEN Critical'))?.ok && checks.find((c) => c.desc.includes('0 OPEN High'))?.ok ? 'x' : ' '}] Executive summary: 0 OPEN Critical; 0 OPEN High
- [${checks.find((c) => c.desc.includes('TEST-03 9/9'))?.ok ? 'x' : ' '}] §11.2.1 TEST-03 smokes re-run 9/9
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r6\` exits 0

## Re-run

\`\`\`bash
npm run verify:r6
# scenario driver only:
npm run e2e:cross-machine
\`\`\`

---

*Generated by scripts/verify-r6-e2e-gate.mjs — Phase R6 plan.md §11*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R6 E2E gate verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}
