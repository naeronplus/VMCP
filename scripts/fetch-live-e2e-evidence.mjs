#!/usr/bin/env node
/**
 * P2.4 helper — pull cross-machine E2E live evidence from a completed GitHub Actions run.
 *
 * Usage:
 *   node scripts/fetch-live-e2e-evidence.mjs --run-id 29214678335
 *   node scripts/fetch-live-e2e-evidence.mjs --latest
 *
 * Downloads the cross-machine-e2e-evidence artifact into docs/e2e/, verifies a
 * cross-machine-e2e-live-*.log contains "LIVE PASS", and refreshes summary row.
 *
 * Requires: gh CLI authenticated with repo read access.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
const e2eDir = join(root, 'docs', 'e2e');
const repo = process.env.PGOS_GIT_REPO || 'naeronplus/VMCP';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: opts.cwd ?? root,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err || `exit ${r.status}`}`);
  }
  return (r.stdout || '').trim();
}

function parseArgs(argv) {
  let runId = null;
  let latest = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-id') runId = argv[++i];
    else if (argv[i] === '--latest') latest = true;
    else if (argv[i] === '--repo') process.env.PGOS_GIT_REPO = argv[++i];
  }
  return { runId, latest };
}

function resolveRunId({ runId, latest }) {
  if (runId) return String(runId);
  if (!latest) {
    throw new Error('pass --run-id <id> or --latest');
  }
  const out = run('gh', [
    'run',
    'list',
    '-R',
    repo,
    '--workflow=e2e_cross_machine.yml',
    '--status=completed',
    '--limit',
    '5',
    '--json',
    'databaseId,conclusion,displayTitle,url',
  ]);
  const runs = JSON.parse(out || '[]');
  const ok = runs.find((r) => r.conclusion === 'success');
  if (!ok) {
    throw new Error(
      'no successful e2e_cross_machine.yml runs found; complete a live run first',
    );
  }
  return String(ok.databaseId);
}

mkdirSync(e2eDir, { recursive: true });
const { runId: argRun, latest } = parseArgs(process.argv);
const runId = resolveRunId({ runId: argRun, latest });

console.log(`Fetching evidence for run ${runId} (${repo})…`);

const work = join(tmpdir(), `pgos-e2e-evidence-${runId}`);
mkdirSync(work, { recursive: true });

run('gh', [
  'run',
  'download',
  runId,
  '-R',
  repo,
  '-n',
  'cross-machine-e2e-evidence',
  '-D',
  work,
]);

// Copy logs + summary into docs/e2e
const copied = [];
function walkCopy(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      walkCopy(p);
      continue;
    }
    if (
      /^cross-machine-e2e.*\.(log|md)$/.test(name.name) ||
      name.name === 'cross-machine-e2e-summary.md'
    ) {
      const dest = join(e2eDir, name.name);
      copyFileSync(p, dest);
      copied.push(name.name);
    }
  }
}
walkCopy(work);

const liveLogs = readdirSync(e2eDir).filter((f) =>
  /^cross-machine-e2e-live-\d{4}-\d{2}-\d{2}\.log$/.test(f),
);
const withPass = liveLogs.filter((f) =>
  readFileSync(join(e2eDir, f), 'utf8').includes('LIVE PASS'),
);

if (withPass.length === 0) {
  console.error('FAIL: no docs/e2e/cross-machine-e2e-live-*.log with LIVE PASS after download');
  console.error('Copied:', copied.join(', ') || '(none)');
  process.exit(1);
}

// Annotate summary if present
const summaryPath = join(e2eDir, 'cross-machine-e2e-summary.md');
if (existsSync(summaryPath)) {
  let s = readFileSync(summaryPath, 'utf8');
  if (!s.includes('Live evidence fetched')) {
    s += `\n\n## Live evidence fetched\n\n`;
    s += `- Run: https://github.com/${repo}/actions/runs/${runId}\n`;
    s += `- Files: ${withPass.join(', ')}\n`;
    s += `- Marker: LIVE PASS\n`;
    writeFileSync(summaryPath, s, 'utf8');
  }
}

console.log('OK: live evidence present');
for (const f of withPass) {
  console.log(`  ${f}`);
}
console.log('Next: git add docs/e2e/cross-machine-e2e-live-*.log docs/e2e/cross-machine-e2e-summary.md');
console.log('      npm run verify:r6');
