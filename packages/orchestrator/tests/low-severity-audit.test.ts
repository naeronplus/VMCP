/**
 * §7.7 L-01–L-12 regression guards (static + pure logic).
 * Heavy integration stays in route-specific suites; these prevent audit drift.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CATALOG } from '@vibrato/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const orchRoot = join(here, '..');

function read(relFromRepo: string): string {
  return readFileSync(join(repoRoot, relFromRepo), 'utf8');
}

describe('L-01 heartbeat rejection uses E013', () => {
  it('jobs route heartbeat failure body includes E013', () => {
    const src = read('packages/orchestrator/src/routes/jobs.ts');
    assert.match(src, /heartbeat/);
    assert.match(src, /code:\s*['"]E013['"]/);
    assert.match(src, /Heartbeat rejected/);
    // Must not leave a bare 403 without code on the heartbeat path
    const heartbeatBlock = src.slice(src.indexOf("'/jobs/:id/heartbeat'"));
    const rejectSnippet = heartbeatBlock.slice(0, 800);
    assert.match(rejectSnippet, /E013/);
    assert.equal(ERROR_CATALOG.E013.code, 'E013');
  });
});

describe('L-02 resolve-secret 404 structured (not E007)', () => {
  it('secrets route returns SECRET_NOT_FOUND, never E007 for missing JWE', () => {
    const src = read('packages/orchestrator/src/routes/secrets.ts');
    assert.match(src, /SECRET_NOT_FOUND/);
    assert.doesNotMatch(
      src,
      /code:\s*['"]E007['"]/,
      'E007 is UID_DUPLICATE_AUTO_FIXED — must not label secret 404',
    );
    assert.equal(ERROR_CATALOG.E007.class, 'UID_DUPLICATE_AUTO_FIXED');
  });
});

describe('L-03 root lint covers all TS workspaces', () => {
  it('root package.json lint chains five packages', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: { lint: string } };
    const lint = pkg.scripts.lint;
    for (const ws of [
      '@vibrato/shared',
      '@vibrato/orchestrator',
      '@vibrato/dashboard',
      '@vibrato/sandbox-service',
      '@vibrato/mcp-server',
    ]) {
      assert.ok(lint.includes(ws), `lint missing ${ws}`);
    }
  });
});

describe('L-04 orchestrator tests live under tests/ and are discovered', () => {
  it('package.json test glob includes tests/**/*.test.ts', () => {
    const pkg = JSON.parse(
      readFileSync(join(orchRoot, 'package.json'), 'utf8'),
    ) as { scripts: { test: string } };
    assert.match(pkg.scripts.test, /tests\/\*\*\/\*\.test\.ts/);
  });

  it('tests/ has at least 13 *.test.ts files (plan baseline; tree may grow)', () => {
    const dir = join(orchRoot, 'tests');
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
    assert.ok(files.length >= 13, `expected ≥13 tests, got ${files.length}`);
  });
});

describe('L-05 REIMPORT_* and ORCHESTRATOR_CACHE_DIR are wired', () => {
  it('job-service embeds reimport policy into SecretEnvelope fields', () => {
    const src = read('packages/orchestrator/src/services/job-service.ts');
    assert.match(src, /reimportTimeoutSec/);
    assert.match(src, /reimportMaxRetries/);
    assert.match(src, /REIMPORT_TIMEOUT_MS/);
  });

  it('resolve-secrets exports REIMPORT_TIMEOUT_SEC / REIMPORT_MAX_RETRIES', () => {
    const sh = read('workers/scripts/resolve-secrets.sh');
    assert.match(sh, /REIMPORT_TIMEOUT_SEC/);
    assert.match(sh, /REIMPORT_MAX_RETRIES/);
    assert.match(sh, /reimportTimeoutSec/);
  });

  it('env schema and orchestrator-cache module wire ORCHESTRATOR_CACHE_DIR', () => {
    const envSrc = read('packages/orchestrator/src/config/env.ts');
    assert.match(envSrc, /ORCHESTRATOR_CACHE_DIR/);
    assert.match(envSrc, /REIMPORT_TIMEOUT_MS/);
    assert.match(envSrc, /REIMPORT_MAX_RETRIES/);
    const cacheSrc = read('packages/orchestrator/src/lib/orchestrator-cache.ts');
    assert.match(cacheSrc, /ensureOrchestratorCacheDir/);
    assert.match(cacheSrc, /ORCHESTRATOR_CACHE_DIR/);
    const indexSrc = read('packages/orchestrator/src/index.ts');
    assert.match(indexSrc, /ensureOrchestratorCacheDir/);
  });

  it('shared SecretEnvelope includes reimport fields', () => {
    const types = read('packages/shared/src/types.ts');
    assert.match(types, /reimportTimeoutSec\?/);
    assert.match(types, /reimportMaxRetries\?/);
  });
});

describe('L-06 secretService.resolve legacy removed', () => {
  it('secret-service has no resolve(jwe, jobId) method body', () => {
    const src = read('packages/orchestrator/src/services/secret-service.ts');
    assert.match(src, /resolveDispatchJwe/);
    assert.doesNotMatch(src, /async resolve\(jwe/);
    assert.match(src, /L-06/);
  });
});

describe('L-07 portable timestamps in parity/perf', () => {
  it('parity-canary and perf-profile use Date.now(), not date +%s%3N', () => {
    for (const rel of [
      'workers/scripts/parity-canary.sh',
      'workers/scripts/perf-profile.sh',
    ]) {
      const sh = read(rel);
      assert.match(sh, /Date\.now\(\)/);
      assert.doesNotMatch(sh, /^[^#]*date[[:space:]]+\+%s%3N/m);
    }
  });
});

describe('L-08 godot_health cron comment matches */30', () => {
  it('root and mirror workflows document ~30 minutes', () => {
    for (const rel of [
      '.github/workflows/godot_health.yml',
      'workers/.github/workflows/godot_health.yml',
    ]) {
      const yml = read(rel);
      assert.match(yml, /\*\/30 \* \* \* \*/);
      assert.match(yml, /30 min/i);
      assert.doesNotMatch(yml, /~5m schedule/i);
    }
  });
});

describe('L-09 Overview uses WebSocket', () => {
  it('OverviewPage imports usePgosWebSocket', () => {
    const src = read('packages/dashboard/src/pages/OverviewPage.tsx');
    assert.match(src, /usePgosWebSocket/);
  });

  it('TiersPage and LocksPage also subscribe for live refresh', () => {
    assert.match(read('packages/dashboard/src/pages/TiersPage.tsx'), /usePgosWebSocket/);
    assert.match(read('packages/dashboard/src/pages/LocksPage.tsx'), /usePgosWebSocket/);
  });
});

describe('L-10 createJob client fields (H-06)', () => {
  it('CreateJobInput includes godotVersion, preferredTier, commitStrategy', () => {
    const src = read('packages/dashboard/src/api/client.ts');
    assert.match(src, /godotVersion\?/);
    assert.match(src, /preferredTier\?/);
    assert.match(src, /commitStrategy\?/);
    assert.match(src, /dependsOnJobId\?/);
  });
});

describe('L-11 git repository + CI triggers', () => {
  it('.git exists at monorepo root', () => {
    assert.ok(existsSync(join(repoRoot, '.git')), 'expected .git (Phase 0 / L-11)');
  });

  it('ci.yml triggers on push and pull_request', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /^on:\s*$/m);
    assert.match(ci, /push:/);
    assert.match(ci, /pull_request:/);
    assert.match(ci, /branches:\s*\[main,\s*master\]/);
  });

  it('configure-git-remote.sh and git-hosting docs exist', () => {
    assert.ok(
      existsSync(join(repoRoot, 'scripts', 'configure-git-remote.sh')),
      'scripts/configure-git-remote.sh',
    );
    assert.ok(
      existsSync(join(repoRoot, 'docs', 'deploy', 'git-hosting.md')),
      'docs/deploy/git-hosting.md',
    );
    const sh = read('scripts/configure-git-remote.sh');
    assert.match(sh, /PGOS_GIT_ORIGIN/);
    assert.match(sh, /git remote add origin/);
    assert.doesNotMatch(sh, /--force/);
  });
});

describe('DOC-02 MIT LICENSE', () => {
  it('LICENSE file exists and is MIT', () => {
    const licPath = join(repoRoot, 'LICENSE');
    assert.ok(existsSync(licPath), 'LICENSE missing (DOC-02)');
    const text = readFileSync(licPath, 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, /Copyright \(c\) 2026/);
    assert.match(text, /Permission is hereby granted/);
  });

  it('root package.json license is MIT', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string };
    assert.equal(pkg.license, 'MIT');
  });
});

describe('L-12 resolve-secrets error path logs status not body', () => {
  it('failure path prints HTTP code only', () => {
    const sh = read('workers/scripts/resolve-secrets.sh');
    assert.match(sh, /resolve-secret failed HTTP \$\{HTTP_CODE\}/);
    assert.match(sh, /L-12/);
    // On failure, BODY must be unset / not echoed
    assert.match(sh, /unset RESP BODY/);
  });
});
