#!/usr/bin/env node
/**
 * Phase R5 — Medium/Low & Hygiene (plan.md §10)
 *
 * M-05 STAGING callback · L-11 git CI/docs · DOC-02 LICENSE · §10.4 doc drift
 *
 * No shortcuts: workflow mirrors, callback smoke, unit tests, static contracts.
 *
 * Writes:
 *   docs/remediation/R5-baseline-<date>.log
 *   docs/remediation/R5-regression-summary.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R5-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R5-regression-summary.md');

const R5_FINDING_IDS = ['M-05', 'L-11', 'DOC-02', 'DOC-DRIFT'];

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

function bashScript(rel) {
  const bash =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : 'bash';
  if (process.platform === 'win32' && !existsSync(bash)) {
    return { ok: false, status: 127, out: 'Git Bash not found' };
  }
  const script = join(root, rel).replace(/\\/g, '/');
  return run(bash, [script], { shell: false });
}

mkdirSync(join(root, 'docs', 'remediation'), { recursive: true });

// ── M-05: STAGING callback ─────────────────────────────────────────

const rootWf = read('.github/workflows/godot_worker.yml');
const mirrorWf = read('workers/.github/workflows/godot_worker.yml');

function stagingUsesCallback(yml) {
  const idx = yml.indexOf('Report STAGING');
  if (idx < 0) return false;
  const block = yml.slice(idx, idx + 500);
  return (
    block.includes('pgos-callback.sh') &&
    block.includes('pgos_patch_job_status') &&
    block.includes('STAGING') &&
    !/curl[\s\S]{0,120}-X\s*PATCH/.test(block)
  );
}

record(
  'M-05',
  'root godot_worker.yml Report STAGING uses pgos_patch_job_status',
  stagingUsesCallback(rootWf),
  '.github/workflows/godot_worker.yml',
);
record(
  'M-05',
  'workers mirror godot_worker.yml Report STAGING uses pgos_patch_job_status',
  stagingUsesCallback(mirrorWf),
  'workers/.github/workflows/godot_worker.yml',
);
record(
  'M-05',
  'resolve-secrets step precedes Report STAGING',
  rootWf.indexOf('resolve-secrets.sh') < rootWf.indexOf('Report STAGING') &&
    rootWf.includes('resolve-secrets.sh'),
  'godot_worker.yml order',
);

const mirrors = run('node', ['scripts/verify-workflow-mirrors.mjs'], {
  shell: false,
});
append('verify-workflow-mirrors', mirrors.out || `(exit ${mirrors.status})`);
record(
  'M-05',
  'workflow mirrors in sync',
  mirrors.ok,
  mirrors.ok ? 'PASS' : `exit ${mirrors.status}`,
);

const callbackSmoke = bashScript('workers/tests/pgos-callback-smoke.sh');
append(
  'pgos-callback-smoke.sh',
  callbackSmoke.out || `(exit ${callbackSmoke.status})`,
);
record(
  'M-05',
  'pgos-callback-smoke (incl. STAGING path + workflow guards)',
  callbackSmoke.ok,
  callbackSmoke.ok ? 'PASS' : `exit ${callbackSmoke.status}`,
);

// ── L-11: git / CI ─────────────────────────────────────────────────

const ciYml = read('.github/workflows/ci.yml');
record(
  'L-11',
  'ci.yml triggers on push to main/master',
  /push:/.test(ciYml) && /branches:\s*\[main,\s*master\]/.test(ciYml),
  'ci.yml',
);
record(
  'L-11',
  'ci.yml triggers on pull_request',
  /pull_request:/.test(ciYml),
  'ci.yml',
);
record(
  'L-11',
  'configure-git-remote.sh exists (no force-push)',
  existsSync(join(root, 'scripts/configure-git-remote.sh')) &&
    read('scripts/configure-git-remote.sh').includes('PGOS_GIT_ORIGIN') &&
    !read('scripts/configure-git-remote.sh').includes('--force'),
  'scripts/configure-git-remote.sh',
);
record(
  'L-11',
  'docs/deploy/git-hosting.md branch protection checklist',
  existsSync(join(root, 'docs/deploy/git-hosting.md')) &&
    read('docs/deploy/git-hosting.md').includes('force') &&
    read('docs/deploy/git-hosting.md').includes('branch protection'),
  'git-hosting.md',
);
record(
  'L-11',
  'README documents clone / configure-git-remote (L-11)',
  read('README.md').includes('configure-git-remote.sh') &&
    read('README.md').includes('git-hosting.md'),
  'README.md',
);

const lowSev = run(
  'node',
  ['--import', 'tsx', '--test', 'tests/low-severity-audit.test.ts'],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('low-severity-audit.test.ts', lowSev.out || `(exit ${lowSev.status})`);
record(
  'L-11',
  'low-severity-audit L-11 tests',
  lowSev.ok,
  lowSev.ok ? 'PASS' : `exit ${lowSev.status}`,
);
record(
  'DOC-02',
  'low-severity-audit DOC-02 tests',
  lowSev.ok,
  lowSev.ok ? 'PASS' : `exit ${lowSev.status}`,
);

// Optional: remote present (operator may complete later)
const remote = run('git', ['remote', '-v'], { shell: false });
append('git remote -v', remote.out || '(none)');
const hasOrigin = (remote.out || '').includes('origin');
record(
  'L-11',
  'git origin remote (optional until operator sets PGOS_GIT_ORIGIN)',
  true, // never fail gate — document status only
  hasOrigin ? 'origin present' : 'not set — run scripts/configure-git-remote.sh',
);

// ── DOC-02: LICENSE ────────────────────────────────────────────────

const licPath = join(root, 'LICENSE');
const licOk =
  existsSync(licPath) &&
  read('LICENSE').includes('MIT License') &&
  read('LICENSE').includes('Copyright');
record('DOC-02', 'LICENSE file is MIT with copyright line', licOk, 'LICENSE');
record(
  'DOC-02',
  'root package.json license MIT',
  read('package.json').includes('"license": "MIT"'),
  'package.json',
);
record(
  'DOC-02',
  'README links to LICENSE',
  read('README.md').includes('./LICENSE') || read('README.md').includes('(./LICENSE)'),
  'README.md',
);

const workspacePkgs = [
  'packages/shared/package.json',
  'packages/orchestrator/package.json',
  'packages/dashboard/package.json',
  'packages/mcp-server/package.json',
  'packages/sandbox-service/package.json',
];
const allMit = workspacePkgs.every((p) => {
  try {
    return JSON.parse(read(p)).license === 'MIT';
  } catch {
    return false;
  }
});
record(
  'DOC-02',
  'workspace packages declare license MIT',
  allMit,
  workspacePkgs.join(', '),
);

// ── DOC-DRIFT (§10.4) ──────────────────────────────────────────────

const compose = read('docker-compose.yml');
record(
  'DOC-DRIFT',
  'docker-compose documents commit-agent install.sh (DEP-02/10.4.1)',
  compose.includes('scripts/install.sh') || compose.includes('commit-agent/scripts/install'),
  'docker-compose.yml',
);

const toolSchemas = read('packages/mcp-server/src/tool-schemas.ts');
const readme = read('README.md');
const toolNames = [
  'list_projects',
  'list_jobs',
  'get_job',
  'create_job',
  'list_locks',
  'get_job_status',
];
const toolsInSchema = toolNames.every((t) => toolSchemas.includes(`'${t}'`));
const toolsInReadme = toolNames.every((t) => readme.includes(t));
record(
  'DOC-DRIFT',
  'README MCP tools match VIBRATO_TOOL_NAMES',
  toolsInSchema && toolsInReadme,
  toolsInReadme ? 'README + tool-schemas.ts' : 'README missing tool',
);

const workersReadme = read('workers/README.md');
record(
  'DOC-DRIFT',
  'workers/README documents target-provisioner + snapshot-export + stat-lock',
  workersReadme.includes('target-provisioner') &&
    workersReadme.includes('snapshot-export') &&
    workersReadme.includes('stat-lock'),
  'workers/README.md',
);

record(
  'M-05',
  'verify:r5 registered in package.json',
  read('package.json').includes('verify:r5'),
  'package.json',
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R5_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R5_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R5 Medium/Low & Hygiene — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §10 Phase R5  
**Scope:** M-05, L-11, DOC-02, documentation drift (§10.4)  
**Gate:** ${failed === 0 ? '**PASSED** — safe to proceed to R6' : '**FAILED** — fix blockers before R6'}  
**Method:** \`npm run verify:r5\` → \`scripts/verify-r5-medium-low-hygiene.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## Automated suite

| Step | Result |
|------|--------|
| workflow mirrors | ${mirrors.ok ? '✅' : '❌'} |
| pgos-callback-smoke | ${callbackSmoke.ok ? '✅' : '❌'} |
| low-severity-audit tests | ${lowSev.ok ? '✅' : '❌'} |
| git origin | ${hasOrigin ? '✅ set' : '⚠️ not set (operator: configure-git-remote.sh)'} |

Full command output: \`docs/remediation/R5-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R5 Definition of Done (plan §10)

- [${checks.find((c) => c.desc.includes('root godot_worker'))?.ok ? 'x' : ' '}] M-05: STAGING uses pgos_callback_patch
- [${checks.find((c) => c.desc.includes('ci.yml triggers on push'))?.ok ? 'x' : ' '}] L-11: CI on push + PR; remote/protection docs + script
- [${checks.find((c) => c.desc.includes('LICENSE file is MIT'))?.ok ? 'x' : ' '}] DOC-02: MIT LICENSE on disk
- [${checks.find((c) => c.desc.includes('README MCP tools'))?.ok ? 'x' : ' '}] §10.4 documentation drift
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r5\` exits 0

### Operator follow-up (L-11 host)

If git origin is not set, run:

\`\`\`bash
export PGOS_GIT_ORIGIN='https://github.com/<org>/<repo>.git'
bash scripts/configure-git-remote.sh
# PGOS_GIT_PUSH=1 bash scripts/configure-git-remote.sh
# then branch protection per docs/deploy/git-hosting.md
\`\`\`

## Re-run

\`\`\`bash
npm run verify:r5
\`\`\`

---

*Generated by scripts/verify-r5-medium-low-hygiene.mjs — Phase R5 plan.md §10*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R5 medium/low hygiene verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  git origin: ${hasOrigin ? 'set' : 'not set (docs/script ready)'}`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}
