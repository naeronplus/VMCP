#!/usr/bin/env node
/**
 * Phase R1 — Critical Production Blockers (plan.md §6)
 *
 * DEP-01: in-repo target JIT SSH provision server
 * C-03:   remote pre-commit S3 snapshot via target snapshot-export
 *
 * No shortcuts:
 *   - go test ./... -count=1 in target-provisioner + commit-agent
 *   - orchestrator DEP-01/C-03 unit tests
 *   - worker shell smokes (snapshot-export, rollback, remote protocol)
 *   - static contract checks per plan §6.1 / §6.2
 *
 * Writes:
 *   docs/remediation/R1-baseline-<date>.log  (gitignored via *.log)
 *   docs/remediation/R1-regression-summary.md (committed)
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R1-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R1-regression-summary.md');

const R1_FINDING_IDS = ['DEP-01', 'C-03'];

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

// ── R1.1 Go test suites (no cache) ───────────────────────────────────

const goSuites = [
  ['go test ./... (target-provisioner)', join(root, 'packages', 'target-provisioner')],
  ['go test ./... (commit-agent)', join(root, 'packages', 'commit-agent')],
];

for (const [name, cwd] of goSuites) {
  const r = run('go', ['test', './...', '-count=1'], { cwd });
  append(name, r.out || `(exit ${r.status})`);
  record('R1.1', name, r.ok, r.ok ? 'PASS' : `exit ${r.status}`);
}

// ── R1.2 Orchestrator tests (DEP-01 / C-03) ──────────────────────────

const orchTests = run(
  'node',
  [
    '--import',
    'tsx',
    '--test',
    'tests/ssh-provision-integration.test.ts',
    'tests/cross-machine-snapshot-envelope.test.ts',
  ],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('orchestrator R1 tests', orchTests.out || `(exit ${orchTests.status})`);
record(
  'R1.2',
  'ssh-provision-integration + cross-machine-snapshot-envelope tests',
  orchTests.ok,
  orchTests.ok ? 'PASS' : `exit ${orchTests.status}`,
);

// ── R1.3 Worker shell smokes ─────────────────────────────────────────

const shellSmokes = [
  'workers/tests/snapshot-export-smoke.sh',
  'workers/tests/snapshot-rollback-smoke.sh',
  'workers/tests/pgos-remote-protocol-smoke.sh',
];

for (const script of shellSmokes) {
  const r = bashScript(script);
  append(script, r.out || `(exit ${r.status})`);
  record('R1.3', script, r.ok, r.ok ? 'PASS' : `exit ${r.status}`);
}

// ── R1.4 DEP-01 static contract checks ─────────────────────────────

const dep01Paths = [
  'packages/target-provisioner/go.mod',
  'packages/target-provisioner/cmd/provisioner/main.go',
  'packages/target-provisioner/internal/handler.go',
  'packages/target-provisioner/internal/keys.go',
  'packages/target-provisioner/internal/ledger.go',
  'packages/target-provisioner/systemd/pgos-target-provisioner.service',
  'packages/target-provisioner/README.md',
];

const dep01FilesOk = dep01Paths.every((p) => existsSync(join(root, p)));
record(
  'DEP-01',
  'target-provisioner package scaffold (go.mod, cmd, internal, systemd, README)',
  dep01FilesOk,
  dep01FilesOk ? 'all present' : 'missing files',
);

const handler = read('packages/target-provisioner/internal/handler.go');
const mainProv = read('packages/target-provisioner/cmd/provisioner/main.go');
const provReadme = read('packages/target-provisioner/README.md');
const sshProvision = read('packages/orchestrator/src/services/ssh-provision.ts');
const envTs = read('packages/orchestrator/src/config/env.ts');
const envExample = read('.env.example');
const railwayMd = read('docs/deploy/railway.md');

record(
  'DEP-01',
  'POST /v1/provision + POST /v1/revoke + TTL sweeper',
  includesAll(handler, [
    'POST /v1/provision',
    'POST /v1/revoke',
    'StartSweeper',
    'http.StatusCreated',
  ]),
  'handler.go routes + sweeper',
);

record(
  'DEP-01',
  'Listen 127.0.0.1:9071 default + PGOS_PROVISION_TOKEN required',
  includesAll(mainProv, ['127.0.0.1:9071', 'PGOS_PROVISION_TOKEN is required']),
  'main.go defaults',
);

record(
  'DEP-01',
  'authorized_keys line: ForcedCommand + environment= + ed25519 validation',
  existsSync(join(root, 'packages/target-provisioner/internal/keys_test.go')) &&
    includesAll(read('packages/target-provisioner/internal/keys.go'), [
      'ValidateEd25519OpenSSH',
      'RenderAuthorizedKeysLine',
      'no-port-forwarding',
      'environment=',
    ]),
  'keys.go + golden test',
);

record(
  'DEP-01',
  'maxSessions per-job enforcement (sessionsUsed < maxSessions)',
  handler.includes('CountActiveForJob') &&
    read('packages/target-provisioner/internal/ledger.go').includes(
      'SessionsUsed < e.MaxSessions',
    ),
  'ledger CountActiveForJob',
);

record(
  'DEP-01',
  'sshd AuthorizedKeysFile documented in README',
  provReadme.includes('AuthorizedKeysFile'),
  'target-provisioner README',
);

record(
  'DEP-01',
  'orchestrator PGOS_PROVISION_TOKEN + singleUse:false',
  includesAll(sshProvision, [
    'PGOS_PROVISION_TOKEN',
    'singleUse: false',
    'provisionPublicKey',
  ]),
  'ssh-provision.ts',
);

record(
  'DEP-01',
  'PGOS_PROVISION_TOKEN in env.ts, .env.example, railway.md',
  envTs.includes('PGOS_PROVISION_TOKEN') &&
    envExample.includes('PGOS_PROVISION_TOKEN') &&
    railwayMd.includes('PGOS_PROVISION_TOKEN'),
  'orchestrator env docs',
);

const handlerTests = readdirSync(
  join(root, 'packages/target-provisioner/internal'),
).filter((f) => f.endsWith('_test.go'));
record(
  'DEP-01',
  `handler tests (auth 401, validation, TTL, revoke) — ${handlerTests.length} files`,
  handlerTests.length >= 2,
  handlerTests.join(', '),
);

// ── R1.5 C-03 static contract checks ───────────────────────────────

const agentMain = read('packages/commit-agent/cmd/agent/main.go');
const agentReadme = read('packages/commit-agent/README.md');
const atomicCommit = read('workers/scripts/atomic-commit.sh');
const postCommit = read('workers/scripts/post-commit-verify.sh');
const jobService = read('packages/orchestrator/src/services/job-service.ts');

record(
  'C-03',
  'snapshot-export verb in commit-agent main.go header + handler',
  includesAll(agentMain, [
    'snapshot-export',
    'cmdSnapshotExport',
    'handleSnapshotExport',
    'snapshotExportExcludes',
  ]),
  'main.go',
);

record(
  'C-03',
  'snapshot-export documented in commit-agent README',
  agentReadme.includes('snapshot-export'),
  'commit-agent README',
);

record(
  'C-03',
  'cross-machine atomic-commit: snapshot-export before stage-receive',
  (() => {
    const snap = atomicCommit.indexOf('snapshot-export');
    const stage = atomicCommit.indexOf('stage-receive');
    return (
      snap > 0 &&
      stage > snap &&
      atomicCommit.includes('pgos_upload_file') &&
      atomicCommit.includes('PRESIGN_SNAPSHOT_PUT')
    );
  })(),
  'atomic-commit.sh ordering',
);

record(
  'C-03',
  'snapshot-export failure → COMMIT_FAILED + E004',
  atomicCommit.includes('pre-commit snapshot-export failed') &&
    atomicCommit.includes('COMMIT_FAILED') &&
    atomicCommit.includes('E004'),
  'atomic-commit.sh error path',
);

record(
  'C-03',
  'cross-machine never uses runner-local TARGET_ROOT for pre-commit snapshot',
  (() => {
    const crossIdx = atomicCommit.indexOf(
      'TARGET_HOST required for cross-machine',
    );
    const crossBlock =
      crossIdx >= 0 ? atomicCommit.slice(crossIdx) : atomicCommit;
    return (
      crossBlock.includes('snapshot-export') &&
      !crossBlock.includes('pgos_upload_dir_tarball')
    );
  })(),
  'cross-machine block uses snapshot-export only',
);

record(
  'C-03',
  'post-commit rollback: S3 GET → restore stdin (primary)',
  postCommit.includes('PRESIGN_SNAPSHOT_GET') &&
    postCommit.includes('pgos_ssh_agent_stdin "restore') &&
    postCommit.includes('pgos_curl_get'),
  'post-commit-verify.sh',
);

record(
  'C-03',
  'job-service presigns snapshotPut + snapshotGet in dispatch envelope',
  jobService.includes('snapshotPut:') &&
    jobService.includes('snapshotGet:') &&
    jobService.includes('presignPut(snapshotKey)'),
  'job-service.ts',
);

const agentTests = read('packages/commit-agent/cmd/agent/main_test.go');
record(
  'C-03',
  'Go tests: golden checksum, missing path, traversal, restore round-trip',
  includesAll(agentTests, [
    'TestSnapshotExport',
    'TestSnapshotExport_MissingPath',
    'TestSnapshotExport_TraversalRejected',
    'TestSnapshotExport_RestoreRoundTrip',
  ]),
  'main_test.go',
);

const pgosS3 = read('workers/scripts/lib/pgos-s3.sh');
record(
  'C-03',
  'pgos_upload_file helper for target snapshot archive',
  pgosS3.includes('pgos_upload_file') && pgosS3.includes('application/gzip'),
  'pgos-s3.sh',
);

const pgosRemote = read('workers/scripts/lib/pgos-remote.sh');
record(
  'C-03',
  'SSH cleanup trap once-per-main-shell (subshell safe for restore)',
  pgosRemote.includes('_PGOS_SSH_CLEANUP_TRAP_SH') &&
    pgosRemote.includes('command substitutions run in subshells'),
  'pgos-remote.sh',
);

record(
  'C-03',
  'post-commit-verify avoids reimport command-sub (REIMPORT_EXIT_CODE)',
  postCommit.includes('REIMPORT_EXIT_CODE') &&
    !/code="\$\(run_reimport\)"/.test(postCommit),
  'post-commit-verify.sh',
);

record(
  'C-03',
  'workers/README documents C-03 backup hierarchy',
  read('workers/README.md').includes('snapshot-export') &&
    read('workers/README.md').includes('target.bak'),
  'workers/README.md',
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R1_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R1_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} contract + test checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R1 Critical Production Blockers — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §6 Phase R1  
**Scope:** DEP-01 (target-provisioner) + C-03 (remote pre-commit S3 snapshot)  
**Gate:** ${failed === 0 ? '**PASSED** — safe to proceed to R2' : '**FAILED** — fix blockers before R2'}  
**Method:** \`npm run verify:r1\` → \`scripts/verify-r1-critical-blockers.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## Automated suite

| Step | Result |
|------|--------|
| go test target-provisioner -count=1 | ${checks.find((c) => c.desc === 'go test ./... (target-provisioner)')?.ok ? '✅' : '❌'} |
| go test commit-agent -count=1 | ${checks.find((c) => c.desc === 'go test ./... (commit-agent)')?.ok ? '✅' : '❌'} |
| orchestrator DEP-01/C-03 tests | ${checks.find((c) => c.desc.includes('ssh-provision-integration'))?.ok ? '✅' : '❌'} |
| snapshot-export-smoke.sh | ${checks.find((c) => c.desc.includes('snapshot-export-smoke'))?.ok ? '✅' : '❌'} |
| snapshot-rollback-smoke.sh | ${checks.find((c) => c.desc.includes('snapshot-rollback-smoke'))?.ok ? '✅' : '❌'} |
| pgos-remote-protocol-smoke.sh | ${checks.find((c) => c.desc.includes('pgos-remote-protocol-smoke'))?.ok ? '✅' : '❌'} |

Full command output: \`docs/remediation/R1-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R1 Definition of Done (plan §6.1.6 + §6.2.6)

- [${checks.find((c) => c.desc === 'go test ./... (target-provisioner)')?.ok ? 'x' : ' '}] \`go test ./...\` in target-provisioner green
- [${checks.find((c) => c.desc.includes('target-provisioner package scaffold'))?.ok ? 'x' : ' '}] target-provisioner package + systemd + README
- [${checks.find((c) => c.desc.includes('ssh-provision-integration'))?.ok ? 'x' : ' '}] Orchestrator provision mock integration test
- [${checks.find((c) => c.desc.includes('snapshot-export-smoke'))?.ok ? 'x' : ' '}] Cross-machine pre-commit snapshot without runner-local tree
- [${checks.find((c) => c.desc.includes('snapshot-rollback-smoke'))?.ok ? 'x' : ' '}] S3-primary rollback via restore stdin
- [${checks.find((c) => c.desc.includes('snapshot-export verb in commit-agent'))?.ok ? 'x' : ' '}] commit-agent \`snapshot-export\` verb + docs
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r1\` exits 0

## Re-run

\`\`\`bash
npm run verify:r1
\`\`\`

---

*Generated by scripts/verify-r1-critical-blockers.mjs — Phase R1 plan.md §6*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R1 critical blockers verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}