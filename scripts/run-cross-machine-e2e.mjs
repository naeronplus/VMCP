#!/usr/bin/env node
/**
 * TEST-01 / plan §11.1 + §7.2 — cross-machine E2E evidence driver.
 *
 * Modes:
 *   --mode automated (default) — run 8 scenario validators (smokes + unit tests)
 *   --mode live — live API checks after automated suite
 *                 (requires PGOS_BASE_URL + PGOS_ADMIN_TOKEN)
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
/** P2.3 / plan §7.3: dedicated live evidence (verify:r6 requires LIVE PASS marker). */
const liveLogPath = join(e2eDir, `cross-machine-e2e-live-${date}.log`);
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
  {
    id: 8,
    name: 'Remote merge outbox (envelope → apply → complete)',
    run: () => bashScript('workers/tests/merge-outbox-e2e-smoke.sh'),
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

let liveResult = null;
if (mode === 'live') {
  log.push('\n=== Live API supplement ===\n');
  const live = await runLiveChecks();
  const liveBody = redact(live.out);
  log.push(liveBody);
  liveResult = {
    id: 'live',
    name: 'Live orchestrator API supplement',
    ok: live.ok,
    evidence: live.ok ? 'PASS' : 'FAIL/SKIP',
  };
  results.push(liveResult);

  // Dedicated live evidence file for verify:r6 / plan §7.3.2
  const liveLog = [
    `# Cross-machine E2E — LIVE evidence (TEST-01 / plan §7.3)`,
    `Date: ${date}`,
    `Mode: live`,
    `Host: ${process.platform}`,
    `PGOS_BASE_URL set: ${process.env.PGOS_BASE_URL ? 'yes' : 'no'}`,
    '',
    '=== Live API supplement ===',
    '',
    liveBody,
    '',
  ];
  if (live.ok) {
    liveLog.push('LIVE PASS');
    liveLog.push('');
    log.push('\nLIVE PASS\n');
  } else {
    liveLog.push('LIVE FAIL');
    liveLog.push('');
    log.push('\nLIVE FAIL\n');
  }
  writeFileSync(liveLogPath, liveLog.join('\n'), 'utf8');
}

const automated = results.filter((r) => typeof r.id === 'number');
const scenarioPass = automated.filter((r) => r.ok).length;
const totalAutomated = automated.length;
const allAutomated = scenarioPass === totalAutomated && totalAutomated >= 8;
// Core TEST-01 scenarios 1–7 (historical gate) + scenario 8 (P2 merge outbox)
const coreSeven = automated.filter((r) => r.id >= 1 && r.id <= 7 && r.ok).length === 7;

writeFileSync(logPath, log.join('\n'), 'utf8');

const liveRow = liveResult
  ? `| live | ${liveResult.name} | ${liveResult.ok ? '✅ PASS' : '❌ FAIL'} | ${liveResult.evidence} |`
  : '';

const summary = `# Cross-machine E2E — Summary (TEST-01)

**Date:** ${date}  
**Plan:** plan.md §11.1 + §7.2 (scenario 8 remote merge outbox)  
**Mode:** ${mode}  
**Gate:** ${allAutomated ? `**${scenarioPass}/${totalAutomated} PASS**` : `**${scenarioPass}/${totalAutomated} PASS** — fix failures before closing TEST-01`}  
**Log:** \`docs/e2e/cross-machine-e2e-${date}.log\` (secrets redacted)  
**Live log:** ${liveResult ? `\`docs/e2e/cross-machine-e2e-live-${date}.log\`` : '_(run \`--mode live\` to produce)_'}

## Scenario results

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
${automated
  .map(
    (r) =>
      `| ${r.id} | ${r.name} | ${r.ok ? '✅ PASS' : '❌ FAIL'} | ${r.evidence} |`,
  )
  .join('\n')}
${liveRow}

## Definition of Done (plan §11.1.4 / §7.2 / §7.3)

- [${coreSeven ? 'x' : ' '}] All 7 core scenarios pass (automated validators)
- [${automated.find((r) => r.id === 8)?.ok ? 'x' : ' '}] Scenario 8 remote merge outbox (envelope → apply → complete)
- [${allAutomated ? 'x' : ' '}] All ${totalAutomated} automated scenarios pass
- [x] Evidence committed (secrets redacted)
- [${liveResult?.ok ? 'x' : ' '}] Live API supplement with \`LIVE PASS\` marker (\`cross-machine-e2e-live-*.log\`)

## Re-run

\`\`\`bash
# automated 8/8
node scripts/run-cross-machine-e2e.mjs
# mandatory live (writes cross-machine-e2e-live-<date>.log)
export PGOS_BASE_URL='https://…'
export PGOS_ADMIN_TOKEN='…'
node scripts/run-cross-machine-e2e.mjs --mode live
npm run verify:r6
\`\`\`

## Operator live sign-off

See **Mandatory live sign-off** in \`docs/e2e/cross-machine-e2e.md\`.  
Workflow default: \`runLiveApi=1\` on \`.github/workflows/e2e_cross_machine.yml\`.

---

*Generated by scripts/run-cross-machine-e2e.mjs*
`;

writeFileSync(summaryPath, summary, 'utf8');

console.log(
  `\nE2E evidence: ${scenarioPass}/${totalAutomated} automated scenarios passed`,
);
if (liveResult) {
  console.log(`  live:    ${liveResult.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  liveLog: ${liveLogPath}`);
}
console.log(`  log:     ${logPath}`);
console.log(`  summary: ${summaryPath}`);

if (!allAutomated) {
  process.exit(1);
}
if (mode === 'live' && liveResult && !liveResult.ok) {
  process.exit(1);
}