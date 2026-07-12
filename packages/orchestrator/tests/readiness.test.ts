import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrchestratorReadiness } from '../src/services/readiness.js';

describe('orchestrator readiness (M-09)', () => {
  it('returns ok when Postgres query and Redis ping succeed', async () => {
    const r = await checkOrchestratorReadiness({
      query: async () => ({ rows: [{ '?column?': 1 }] }),
      ping: async () => 'PONG',
    });
    assert.deepEqual(r, { ok: true });
  });

  it('returns 503 when Postgres is down', async () => {
    const r = await checkOrchestratorReadiness({
      query: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
      ping: async () => 'PONG',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.statusCode, 503);
      assert.match(r.error, /ECONNREFUSED|5432/);
    }
  });

  it('returns 503 when Redis is down', async () => {
    const r = await checkOrchestratorReadiness({
      query: async () => ({}),
      ping: async () => {
        throw new Error('Redis connection lost');
      },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.statusCode, 503);
      assert.match(r.error, /Redis/i);
    }
  });

  it('does not call ping if query already failed', async () => {
    let pingCalled = false;
    const r = await checkOrchestratorReadiness({
      query: async () => {
        throw new Error('db down');
      },
      ping: async () => {
        pingCalled = true;
        return 'PONG';
      },
    });
    assert.equal(r.ok, false);
    // Sequential await: if query throws, ping is not reached
    assert.equal(pingCalled, false);
  });

  it('railway.toml healthcheckPath is /ready not /health', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const toml = readFileSync(join(root, 'railway.toml'), 'utf8');
    assert.match(toml, /healthcheckPath\s*=\s*"\/ready"/);
    assert.doesNotMatch(toml, /healthcheckPath\s*=\s*"\/health"/);
  });

  it('sandbox railway.toml exists for multi-service deploy (M-08)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const path = join(root, 'packages/sandbox-service/railway.toml');
    assert.ok(existsSync(path), 'missing packages/sandbox-service/railway.toml');
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /SANDBOX|sandbox/i);
  });
});
