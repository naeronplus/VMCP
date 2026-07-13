#!/usr/bin/env node
/**
 * Phase R4 — Security & Deployment Hardening (plan.md §9)
 *
 * SEC-02 dedicated provision token · SEC-01 mTLS · CM-LOCK-01 stat-lock
 * DEP-02 install.sh · DEP-03 compose healthchecks
 * DEP-04 target-provisioner artifact · NODE-DRIFT Node 20 · MINIO-HC
 *
 * No shortcuts: real unit tests + Go tests + static contracts.
 *
 * Writes:
 *   docs/remediation/R4-baseline-<date>.log
 *   docs/remediation/R4-regression-summary.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const logPath = join(root, 'docs', 'remediation', `R4-baseline-${date}.log`);
const summaryPath = join(root, 'docs', 'remediation', 'R4-regression-summary.md');

const R4_FINDING_IDS = [
  'SEC-02',
  'SEC-01',
  'CM-LOCK-01',
  'DEP-02',
  'DEP-03',
  'DEP-04',
  'NODE-DRIFT',
  'MINIO-HC',
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

// ── SEC-02 + SEC-01: production validation + mTLS unit tests ────────

const prodVal = run(
  'node',
  ['--import', 'tsx', '--test', 'tests/production-validation.test.ts'],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('production-validation.test.ts', prodVal.out || `(exit ${prodVal.status})`);
record('SEC-02', 'production-validation SEC-02 tests', prodVal.ok, prodVal.ok ? 'PASS' : `exit ${prodVal.status}`);
record('SEC-01', 'production-validation SEC-01 mTLS pair checks', prodVal.ok, prodVal.ok ? 'PASS' : `exit ${prodVal.status}`);

const mtlsTests = run(
  'node',
  ['--import', 'tsx', '--test', 'tests/ssh-provision-mtls.test.ts'],
  { cwd: join(root, 'packages', 'orchestrator'), shell: false },
);
append('ssh-provision-mtls.test.ts', mtlsTests.out || `(exit ${mtlsTests.status})`);
record('SEC-01', 'ssh-provision-mtls.test.ts (loader + optional HTTPS peer)', mtlsTests.ok, mtlsTests.ok ? 'PASS' : `exit ${mtlsTests.status}`);

const sshSrc = read('packages/orchestrator/src/services/ssh-provision.ts');
const envSrc = read('packages/orchestrator/src/config/env.ts');
const prodSrc = read('packages/orchestrator/src/config/production-validation.ts');
const jobSrc = read('packages/orchestrator/src/services/job-service.ts');

record(
  'SEC-02',
  'PGOS_PROVISION_TOKEN in env.ts',
  envSrc.includes('PGOS_PROVISION_TOKEN'),
  'env.ts',
);
record(
  'SEC-02',
  'validateProvisionTokenProduction rejects sandbox default / coupling',
  prodSrc.includes('validateProvisionTokenProduction') &&
    prodSrc.includes('INSECURE_SANDBOX_DEFAULT') &&
    prodSrc.includes('differ from SANDBOX_INTERNAL_TOKEN'),
  'production-validation.ts',
);
record(
  'SEC-02',
  'ssh-provision prefers PGOS_PROVISION_TOKEN with fallback warning',
  sshSrc.includes('resolveProvisionBearerToken') &&
    sshSrc.includes('sandbox_token_fallback'),
  'ssh-provision.ts',
);
record(
  'SEC-02',
  '.env.example documents separate provision token',
  read('.env.example').includes('PGOS_PROVISION_TOKEN') &&
    read('.env.example').includes('SANDBOX_INTERNAL_TOKEN'),
  '.env.example',
);
record(
  'SEC-02',
  'railway.md documents PGOS_PROVISION_TOKEN SEC-02',
  read('docs/deploy/railway.md').includes('PGOS_PROVISION_TOKEN') &&
    read('docs/deploy/railway.md').includes('SEC-02'),
  'railway.md',
);

record(
  'SEC-01',
  'env exports PGOS_PROVISION_MTLS_CERT/KEY/CA',
  envSrc.includes('PGOS_PROVISION_MTLS_CERT') &&
    envSrc.includes('PGOS_PROVISION_MTLS_KEY') &&
    envSrc.includes('PGOS_PROVISION_MTLS_CA'),
  'env.ts',
);
record(
  'SEC-01',
  'loadProvisionMtlsMaterial + provisionHttpPost mTLS path',
  sshSrc.includes('loadProvisionMtlsMaterial') &&
    sshSrc.includes('provisionHttpPost') &&
    sshSrc.includes('https.Agent'),
  'ssh-provision.ts',
);
record(
  'SEC-01',
  'job-service passes mTLS paths into provisionPublicKey',
  jobSrc.includes('PGOS_PROVISION_MTLS_CERT') &&
    jobSrc.includes('mtlsCert'),
  'job-service.ts',
);
record(
  'SEC-01',
  'target-provisioner optional TLS/mTLS env',
  read('packages/target-provisioner/cmd/provisioner/main.go').includes(
    'PGOS_PROVISION_TLS_CLIENT_CA',
  ) &&
    read('packages/target-provisioner/cmd/provisioner/main.go').includes(
      'RequireAndVerifyClientCert',
    ),
  'target-provisioner main.go',
);
record(
  'SEC-01',
  'railway.md recommends mTLS over bearer-only',
  read('docs/deploy/railway.md').includes('mTLS') &&
    read('docs/deploy/railway.md').includes('PGOS_PROVISION_MTLS'),
  'railway.md',
);

// ── CM-LOCK-01 ─────────────────────────────────────────────────────

const goAgent = run('go', ['test', './...', '-count=1'], {
  cwd: join(root, 'packages', 'commit-agent'),
  shell: false,
});
append('commit-agent go test', goAgent.out || `(exit ${goAgent.status})`);
record('CM-LOCK-01', 'commit-agent go test (incl. stat-lock)', goAgent.ok, goAgent.ok ? 'PASS' : `exit ${goAgent.status}`);

const agentMain = read('packages/commit-agent/cmd/agent/main.go');
const atomic = read('workers/scripts/atomic-commit.sh');
record(
  'CM-LOCK-01',
  'stat-lock verb in commit-agent',
  agentMain.includes('cmdStatLock') &&
    agentMain.includes('project.godot.lock') &&
    agentMain.includes('unlocked'),
  'main.go',
);
record(
  'CM-LOCK-01',
  'atomic-commit cross-machine wait_for_editor_lock_remote uses stat-lock',
  atomic.includes('wait_for_editor_lock_remote') &&
    atomic.includes('stat-lock') &&
    atomic.includes('PAUSED_EDITOR_LOCK'),
  'atomic-commit.sh',
);

const remoteSmoke = bashScript('workers/tests/pgos-remote-protocol-smoke.sh');
append('pgos-remote-protocol-smoke.sh', remoteSmoke.out || `(exit ${remoteSmoke.status})`);
record(
  'CM-LOCK-01',
  'pgos-remote-protocol-smoke includes stat-lock',
  remoteSmoke.ok,
  remoteSmoke.ok ? 'PASS' : `exit ${remoteSmoke.status}`,
);

// ── DEP-02 ─────────────────────────────────────────────────────────

const installSh = 'packages/commit-agent/scripts/install.sh';
const onceBin = read('packages/commit-agent/bin/commit-agent-once');
record(
  'DEP-02',
  'install.sh exists and honors COMMIT_AGENT_BIN',
  existsSync(join(root, installSh)) &&
    read(installSh).includes('COMMIT_AGENT_BIN') &&
    read(installSh).includes('go build'),
  installSh,
);
record(
  'DEP-02',
  'commit-agent-once uses COMMIT_AGENT_BIN default',
  onceBin.includes('COMMIT_AGENT_BIN:-/usr/local/bin/commit-agent'),
  'bin/commit-agent-once',
);
record(
  'DEP-02',
  'CI uploads commit-agent artifact',
  read('.github/workflows/ci.yml').includes('commit-agent-linux-amd64') &&
    read('.github/workflows/ci.yml').includes('upload-artifact'),
  'ci.yml',
);
record(
  'DEP-02',
  'docker-compose / README link install.sh',
  read('docker-compose.yml').includes('scripts/install.sh') &&
    read('packages/commit-agent/README.md').includes('install.sh'),
  'compose + README',
);

// ── DEP-04 (target-provisioner CI artifact + install) ──────────────

const ciYml = read('.github/workflows/ci.yml');
const tpInstall = 'packages/target-provisioner/scripts/install.sh';
record(
  'DEP-04',
  'CI builds and uploads target-provisioner-linux-amd64',
  ciYml.includes('target-provisioner-linux-amd64') &&
    ciYml.includes('go build -o /tmp/pgos-target-provisioner') &&
    ciYml.includes('upload-artifact'),
  'ci.yml',
);
record(
  'DEP-04',
  'target-provisioner install.sh exists (DEP-02 parity)',
  existsSync(join(root, tpInstall)) &&
    read(tpInstall).includes('go build') &&
    read(tpInstall).includes('PROVISIONER_BIN'),
  tpInstall,
);
record(
  'DEP-04',
  'target-provisioner README documents install.sh + CI artifact',
  read('packages/target-provisioner/README.md').includes('install.sh') &&
    read('packages/target-provisioner/README.md').includes(
      'target-provisioner-linux-amd64',
    ),
  'packages/target-provisioner/README.md',
);

// ── NODE-DRIFT (production containers Node 20) ─────────────────────

const orchDocker = read('packages/orchestrator/Dockerfile');
const sandboxDocker = read('packages/sandbox-service/Dockerfile');
record(
  'NODE-DRIFT',
  'orchestrator Dockerfile uses node:20 (both stages)',
  (orchDocker.match(/FROM node:20/g) || []).length >= 2 &&
    !orchDocker.includes('node:22'),
  'packages/orchestrator/Dockerfile',
);
record(
  'NODE-DRIFT',
  'sandbox-service Dockerfile uses node:20 (both stages)',
  (sandboxDocker.match(/FROM node:20/g) || []).length >= 2 &&
    !sandboxDocker.includes('node:22'),
  'packages/sandbox-service/Dockerfile',
);

// ── DEP-03 ─────────────────────────────────────────────────────────

const compose = read('docker-compose.yml');
const readme = read('README.md');
record(
  'DEP-03',
  'orchestrator healthcheck hits /ready',
  compose.includes('8080/ready') && compose.includes('healthcheck:'),
  'docker-compose.yml',
);
record(
  'DEP-03',
  'sandbox healthcheck hits /health',
  compose.includes('8090/health'),
  'docker-compose.yml',
);
record(
  'DEP-03',
  'depends_on sandbox service_healthy for orchestrator',
  /sandbox:\s*\n\s*condition:\s*service_healthy/.test(compose) ||
    compose.includes('condition: service_healthy'),
  'docker-compose.yml',
);
// Stronger: orchestrator block must depend on sandbox healthy
const orchIdx = compose.indexOf('orchestrator:');
const sandboxDep =
  orchIdx >= 0 &&
  compose.slice(orchIdx, orchIdx + 2500).includes('sandbox:') &&
  compose.slice(orchIdx, orchIdx + 2500).includes('service_healthy');
record(
  'DEP-03',
  'orchestrator depends_on sandbox with service_healthy',
  sandboxDep,
  'docker-compose.yml orchestrator',
);
record(
  'DEP-03',
  'README Option A documents compose healthy /ready wait',
  readme.includes('DEP-03') ||
    (readme.includes('/ready') && readme.includes('healthy')),
  'README.md',
);

// ── MINIO-HC ───────────────────────────────────────────────────────

const minioBlock = (() => {
  const i = compose.indexOf('minio:');
  if (i < 0) return '';
  // Until minio-init service
  const j = compose.indexOf('minio-init:', i + 1);
  return j > i ? compose.slice(i, j) : compose.slice(i, i + 800);
})();
record(
  'MINIO-HC',
  'minio healthcheck hits /minio/health/live',
  minioBlock.includes('healthcheck:') &&
    minioBlock.includes('/minio/health/live'),
  'docker-compose.yml minio',
);
const minioInitIdx = compose.indexOf('minio-init:');
const minioInitBlock =
  minioInitIdx >= 0 ? compose.slice(minioInitIdx, minioInitIdx + 500) : '';
record(
  'MINIO-HC',
  'minio-init depends_on minio service_healthy',
  minioInitBlock.includes('minio:') &&
    minioInitBlock.includes('service_healthy'),
  'docker-compose.yml minio-init',
);

// ── target-provisioner go tests (SEC-01 TLS unit) ──────────────────

const goProv = run('go', ['test', './...', '-count=1'], {
  cwd: join(root, 'packages', 'target-provisioner'),
  shell: false,
});
append('target-provisioner go test', goProv.out || `(exit ${goProv.status})`);
record('SEC-01', 'target-provisioner go test (TLS config)', goProv.ok, goProv.ok ? 'PASS' : `exit ${goProv.status}`);

record(
  'SEC-02',
  'verify:r4 registered in package.json',
  read('package.json').includes('verify:r4'),
  'package.json',
);

// ── Write artifacts ──────────────────────────────────────────────────

writeFileSync(logPath, log.join('\n'), 'utf8');

const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;

const findingById = new Map();
for (const c of checks) {
  if (!R4_FINDING_IDS.includes(c.id)) continue;
  const prev = findingById.get(c.id);
  if (!prev) {
    findingById.set(c.id, { ok: c.ok, rows: [c] });
    continue;
  }
  prev.rows.push(c);
  if (!c.ok) prev.ok = false;
}

const findingRows = R4_FINDING_IDS.map((id) => {
  const g = findingById.get(id);
  if (!g) return `| ${id} | (no checks) | ❌ | missing |`;
  const pass = g.rows.filter((r) => r.ok).length;
  return `| ${id} | ${g.rows.length} checks | ${g.ok ? '✅' : '❌'} | ${pass}/${g.rows.length} pass |`;
});

const detailRows = checks
  .map((c) => `| ${c.id} | ${c.desc} | ${c.ok ? '✅' : '❌'} | ${c.evidence} |`)
  .join('\n');

const summary = `# R4 Security & Deployment Hardening — Verification Summary

**Date:** ${date}  
**Plan:** plan.md §9 Phase R4  
**Scope:** SEC-02, SEC-01, CM-LOCK-01, DEP-02, DEP-03, DEP-04, NODE-DRIFT, MINIO-HC  
**Gate:** ${failed === 0 ? '**PASSED** — safe to proceed to R5' : '**FAILED** — fix blockers before R5'}  
**Method:** \`npm run verify:r4\` → \`scripts/verify-r4-security-deployment.mjs\`

## Finding closure

| ID | Scope | Result | Evidence |
|----|-------|--------|----------|
${findingRows.join('\n')}

## Automated suite

| Step | Result |
|------|--------|
| production-validation + mTLS tests | ${prodVal.ok && mtlsTests.ok ? '✅' : '❌'} |
| commit-agent go test | ${goAgent.ok ? '✅' : '❌'} |
| target-provisioner go test | ${goProv.ok ? '✅' : '❌'} |
| pgos-remote-protocol-smoke (stat-lock) | ${remoteSmoke.ok ? '✅' : '❌'} |

Full command output: \`docs/remediation/R4-baseline-${date}.log\` (gitignored).

## All checks (${passCount}/${checks.length})

| ID | Check | Result | Evidence |
|----|-------|--------|----------|
${detailRows}

## R4 Definition of Done (plan §9.1–§9.5)

- [${checks.find((c) => c.desc.includes('validateProvisionTokenProduction'))?.ok ? 'x' : ' '}] SEC-02: dedicated provision token + production validation
- [${checks.find((c) => c.desc.includes('loadProvisionMtlsMaterial'))?.ok ? 'x' : ' '}] SEC-01: mTLS client + provisioner TLS
- [${checks.find((c) => c.desc.includes('stat-lock verb'))?.ok ? 'x' : ' '}] CM-LOCK-01: remote stat-lock
- [${checks.find((c) => c.desc.includes('install.sh exists'))?.ok ? 'x' : ' '}] DEP-02: install.sh + COMMIT_AGENT_BIN
- [${checks.find((c) => c.desc.includes('orchestrator healthcheck hits /ready'))?.ok ? 'x' : ' '}] DEP-03: compose /ready healthchecks
- [${failed === 0 ? 'x' : ' '}] \`npm run verify:r4\` exits 0

## Re-run

\`\`\`bash
npm run verify:r4
\`\`\`

---

*Generated by scripts/verify-r4-security-deployment.mjs — Phase R4 plan.md §9*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`R4 security & deployment verification: ${failed === 0 ? 'PASSED' : 'FAILED'}`);
console.log(`  checks: ${passCount} passed, ${failCount} failed`);
console.log(`  log:    ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (failed > 0) {
  for (const c of checks.filter((x) => !x.ok)) {
    console.error(`  FAIL [${c.id}] ${c.desc} — ${c.evidence}`);
  }
  process.exit(1);
}
