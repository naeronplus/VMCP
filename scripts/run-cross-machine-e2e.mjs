#!/usr/bin/env node
/**
 * TEST-01 / plan §11.1 — cross-machine E2E evidence driver.
 *
 * Modes:
 *   --mode automated (default) — run 7 scenario validators (smokes + unit tests)
 *   --mode live — optional live API checks (requires PGOS_BASE_URL + PGOS_ADMIN_TOKEN)
 *
 * Writes (redacted):
 *   docs/e2e/cross-machine-e2e-<date>.log
 *   docs/e2e/cross-machine-e2e-summary.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const date = new Date().toISOString().slice(0, 10);
const e2eDir = join(root, 'docs', 'e2e');
const logPath = join(e2eDir, `cross-machine-e2e-${date}.log`);
const summaryPath = join(e2eDir, 'cross-machine-e2e-summary.md');

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'automated';

const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /PGOS_ADMIN_TOKEN[=:]\s*\S+/gi,
  /CALLBACK_TOKEN[=:]\s*\S+/gi,
  /PGOS_PROVISION_TOKEN[=:]\s*\S+/gi,
  /secretJwe[=:]\s*\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /https?:\/\/[^\s?]+(\?[^\s]*)?/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /sk-[A-Za-z0-9]+/g,
];

function redact(text) {
  let out = text;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m) => {
      if (m.startsWith('http')) return '[REDACTED_URL]';
      if (m.includes('Bearer')) return 'Bearer [REDACTED]';
      return m.split(/[=:]/)[0] + '=[REDACTED]';
    });
  }
  return out;
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
    timeout: opts.timeoutMs ?? 300_000,
  });
  const out = [r.stdout ?? '', r.stderr ?? ''].filter(Boolean).join('\n');
  return { ok: r.status === 0, status: r.status ?? 1, out, signal: r.signal };
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

/** @type {{ id: number, name: string, run: () => { ok: boolean, out: string } }[]} */
const SCENARIOS = [
  {
    id: 1,
    name: 'Provision key on target (metadata.targetHost + targetProvisionUrl)',
    run: () =>
      run(
        'node',
        [
          '--import',
          'tsx',
          '--test',
          'tests/ssh-provision-integration.test.ts',
        ],
        { cwd: join(root, 'packages', 'orchestrator'), shell: false },
      ),
  },
  {
    id: 2,
    name: 'Happy path verbs + heartbeat lifecycle',
    run: () => {
      const a = bashScript('workers/tests/pgos-remote-protocol-smoke.sh');
      if (!a.ok) return a;
      return bashScript('workers/tests/heartbeat-lifecycle-smoke.sh');
    },
  },
  {
    id: 3,
    name: 'Provision failure — DISPATCH_FAILED, no SSH in JWE',
    run: () =>
      run(
        'node',
        ['--import', 'tsx', '--test', 'tests/provision-dispatch.test.ts'],
        { cwd: join(root, 'packages', 'orchestrator'), shell: false },
      ),
  },
  {
    id: 4,
    name: 'Wrong fencing owner — commit rejected (E013 class)',
    run: () =>
      run(
        'go',
        [
          'test',
          '-count=1',
          '-run',
          'TestDoCommit_FencingViaHTTPMock_AcceptsAndRejects|TestFencingValidateTokenHTTP_Invalid',
          './...',
        ],
        { cwd: join(root, 'packages', 'commit-agent'), shell: false },
      ),
  },
  {
    id: 5,
    name: 'Reimport fail → S3 snapshot rollback',
    run: () => bashScript('workers/tests/snapshot-rollback-smoke.sh'),
  },
  {
    id: 6,
    name: 'Host backup only (S3 disabled break-glass)',
    run: () => bashScript('workers/tests/host-backup-rollback-smoke.sh'),
  },
  {
    id: 7,
    name: 'Editor lock on target (stat-lock / E012)',
    run: () => bashScript('workers/tests/editor-lock-cross-machine-smoke.sh'),
  },
];

function runLiveChecks() {
  const base = process.env.PGOS_BASE_URL;
  const token = process.env.PGOS_ADMIN_TOKEN;
  if (!base || !token) {
    return {
      ok: false,
      out: 'SKIP live: PGOS_BASE_URL and PGOS_ADMIN_TOKEN required',
    };
  }
  const lines = [];
  let ok = true;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  async function fetchJson(path, init) {
    const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  return (async () => {
    try {
      const ready = await fetch(`${base.replace(/\/$/, '')}/ready`);
      lines.push(`GET /ready → ${ready.status}`);
      if (!ready.ok) ok = false;

      const projects = await fetchJson('/api/v1/projects');
      lines.push(`GET /api/v1/projects → ${projects.status}`);
      if (projects.status !== 200) ok = false;

      const badProvision = process.env.E2E_BAD_PROVISION_URL || 'http://127.0.0.1:1/nope';
      const projBody = {
        name: `e2e-provision-fail-${Date.now()}`,
        metadata: {
          targetHost: 'user@unreachable.invalid',
          targetProvisionUrl: badProvision,
        },
      };
      const created = await fetchJson('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify(projBody),
      });
      lines.push(`POST project (bad provision URL) → ${created.status}`);
      if (created.status < 200 || created.status >= 300) {
        ok = false;
      } else if (created.body?.id) {
        const job = await fetchJson('/api/v1/jobs', {
          method: 'POST',
          body: JSON.stringify({
            projectId: created.body.id,
            commitStrategy: 'cross-machine',
            godotVersion: process.env.E2E_GODOT_VERSION || '4.3.1',
          }),
        });
        lines.push(`POST job (cross-machine) → ${job.status}`);
        if (job.body?.id) {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await fetchJson(`/api/v1/jobs/${job.body.id}`);
            const status = st.body?.status ?? st.body?.job?.status;
            lines.push(`  poll status=${status}`);
            if (status === 'DISPATCH_FAILED' || status === 'FAILED') break;
            if (status === 'COMPLETED') break;
          }
        }
      }
    } catch (err) {
      ok = false;
      lines.push(`live error: ${err.message}`);
    }
    return { ok, out: lines.join('\n') };
  })();
}

mkdirSync(e2eDir, { recursive: true });

const log = [];
const results = [];

log.push(`# Cross-machine E2E evidence log`);
log.push(`Date: ${date}`);
log.push(`Mode: ${mode}`);
log.push(`Host: ${process.platform}`);
log.push('');

for (const sc of SCENARIOS) {
  log.push(`\n=== Scenario ${sc.id}: ${sc.name} ===\n`);
  const r = sc.run();
  const resolved = r instanceof Promise ? await r : r;
  results.push({
    id: sc.id,
    name: sc.name,
    ok: resolved.ok,
    evidence: resolved.ok ? 'PASS' : `exit ${resolved.status ?? 1}`,
  });
  log.push(redact(resolved.out || `(no output, exit ${resolved.status})`));
  console.log(
    `  scenario ${sc.id}: ${resolved.ok ? 'PASS' : 'FAIL'} — ${sc.name}`,
  );
}

if (mode === 'live') {
  log.push('\n=== Live API supplement ===\n');
  const live = await runLiveChecks();
  log.push(redact(live.out));
  results.push({
    id: 8,
    name: 'Live orchestrator API supplement',
    ok: live.ok,
    evidence: live.ok ? 'PASS' : 'FAIL/SKIP',
  });
}

const passCount = results.filter((r) => r.ok).length;
const scenarioPass = results.filter((r) => r.id <= 7 && r.ok).length;
const allSeven = scenarioPass === 7;

writeFileSync(logPath, log.join('\n'), 'utf8');

const summary = `# Cross-machine E2E — Summary (TEST-01)

**Date:** ${date}  
**Plan:** plan.md §11.1  
**Mode:** ${mode}  
**Gate:** ${allSeven ? '**7/7 PASS**' : `**${scenarioPass}/7 PASS** — fix failures before closing TEST-01`}  
**Log:** \`docs/e2e/cross-machine-e2e-${date}.log\` (secrets redacted)

## Scenario results

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
${results
  .filter((r) => r.id <= 7)
  .map(
    (r) =>
      `| ${r.id} | ${r.name} | ${r.ok ? '✅ PASS' : '❌ FAIL'} | ${r.evidence} |`,
  )
  .join('\n')}

## Definition of Done (plan §11.1.4)

- [${allSeven ? 'x' : ' '}] All 7 scenarios pass (automated validators)
- [x] Evidence committed (secrets redacted)
- [${allSeven ? 'x' : ' '}] TEST-01 closed in \`report.md\`

## Re-run

\`\`\`bash
npm run verify:r6
# or scenario driver only:
node scripts/run-cross-machine-e2e.mjs
\`\`\`

## Operator live sign-off (optional)

Trigger \`.github/workflows/e2e_cross_machine.yml\` on a \`godot-worker\` runner with production secrets, or:

\`\`\`bash
export PGOS_BASE_URL='https://…'
export PGOS_ADMIN_TOKEN='…'
node scripts/run-cross-machine-e2e.mjs --mode live
\`\`\`

---

*Generated by scripts/run-cross-machine-e2e.mjs*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(`\nE2E evidence: ${scenarioPass}/7 scenarios passed`);
console.log(`  log:     ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (!allSeven) {
  process.exit(1);
}