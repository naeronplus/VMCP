/**
 * M-15 / 7.5.2–7.5.4 — /v1/execute timeout kill, network deny, memory limit.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildSandboxApp } from '../src/sandbox-app.js';
import { memoryLimitToMb, runIsolated, runWorkerThread } from '../src/run-isolated.js';

const TOKEN = 'test-sandbox-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('memoryLimitToMb (resourceLimits wiring)', () => {
  it('maps MiB request to maxOldGenerationSizeMb with floor 64', () => {
    assert.equal(memoryLimitToMb(512 * 1024 * 1024), 512);
    assert.equal(memoryLimitToMb(32 * 1024 * 1024), 64); // floor
    assert.equal(memoryLimitToMb(128 * 1024 * 1024), 128);
  });
});

describe('/v1/execute HTTP policy (M-15)', () => {
  let app: FastifyInstance;

  before(async () => {
    // Clear Firecracker so worker_thread path is used
    delete process.env.FIRECRACKER_SOCKET;
    app = buildSandboxApp({
      internalToken: TOKEN,
      logger: false,
      env: { ...process.env, FIRECRACKER_SOCKET: undefined },
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('rejects missing auth with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { extensionId: 'ext-1' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('happy path returns ok with echo inputs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-happy',
        inputs: { foo: 'bar' },
        network: false,
        limits: { timeoutSeconds: 10, memoryMiB: 128 },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ok: boolean;
      result: { ok?: boolean; extensionId?: string; echo?: { foo?: string } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.result.extensionId, 'ext-happy');
    assert.equal(body.result.echo?.foo, 'bar');
  });

  // 7.5.3 Network deny
  it('7.5.3 network deny when fetchUrl set and network=false → 403 E016', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-net',
        network: false,
        inputs: { fetchUrl: 'https://evil.example/api' },
        limits: { timeoutSeconds: 10, memoryMiB: 128 },
      },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as {
      ok: boolean;
      error: string;
      code: string;
      message: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'EXTENSION_NETWORK_DENIED');
    assert.equal(body.code, 'E016');
    assert.match(body.message, /NETWORK_DENIED/);
  });

  it('7.5.3 network deny when domain not in approvedDomains → 403 E016', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-net-domain',
        network: true,
        approvedDomains: ['allowed.example'],
        inputs: { fetchUrl: 'https://evil.example/x' },
        limits: { timeoutSeconds: 10, memoryMiB: 128 },
      },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, 'E016');
    assert.match(body.message, /not in approved list|NETWORK_DENIED/);
  });

  it('network allowed for approved domain succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-net-ok',
        network: true,
        approvedDomains: ['allowed.example'],
        inputs: { fetchUrl: 'https://allowed.example/ok' },
        limits: { timeoutSeconds: 10, memoryMiB: 128 },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { ok: boolean }).ok, true);
  });

  // 7.5.2 Timeout kill
  it('7.5.2 timeout kill when sleepMs exceeds timeoutSeconds → 504 E009', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-slow',
        inputs: { sleepMs: 5000 },
        limits: { timeoutSeconds: 1, memoryMiB: 128 },
      },
    });
    assert.equal(res.statusCode, 504);
    const body = res.json() as {
      ok: boolean;
      error: string;
      code: string;
      message: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'EXTENSION_EXEC_TIMEOUT');
    assert.equal(body.code, 'E009');
    assert.match(body.message, /TIMEOUT/i);
  });

  it('maps injected TIMEOUT errors to 504 (handler branch)', async () => {
    const app2 = buildSandboxApp({
      internalToken: TOKEN,
      logger: false,
      runIsolatedImpl: async () => {
        throw new Error('TIMEOUT: forced');
      },
    });
    await app2.ready();
    const res = await app2.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: { extensionId: 'x', limits: { timeoutSeconds: 1 } },
    });
    assert.equal(res.statusCode, 504);
    assert.equal((res.json() as { code: string }).code, 'E009');
    await app2.close();
  });

  // 7.5.4 Memory limit path
  it('7.5.4 MEMORY_LIMIT from runner maps to 500 EXTENSION_MEMORY_LIMIT', async () => {
    const app2 = buildSandboxApp({
      internalToken: TOKEN,
      logger: false,
      runIsolatedImpl: async () => {
        throw new Error('MEMORY_LIMIT: heap out of memory');
      },
    });
    await app2.ready();
    const res = await app2.inject({
      method: 'POST',
      url: '/v1/execute',
      headers: AUTH,
      payload: {
        extensionId: 'ext-mem',
        limits: { memoryMiB: 64, timeoutSeconds: 5 },
      },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json() as { error: string; code: string; message: string };
    assert.equal(body.error, 'EXTENSION_MEMORY_LIMIT');
    assert.equal(body.code, 'E009');
    assert.match(body.message, /MEMORY_LIMIT/);
    await app2.close();
  });

  it('7.5.4 worker resourceLimits applied — large allocate under tight limit fails', async () => {
    // Real worker_threads resourceLimits path (not inject).
    // Use low memory + aggressive allocate; accept MEMORY_LIMIT, worker error, or exit.
    const tightBytes = 64 * 1024 * 1024; // floor 64 MiB old-gen
    await assert.rejects(
      () =>
        runWorkerThread({
          extensionId: 'ext-oom',
          inputs: { allocateMiB: 512 },
          network: false,
          approvedDomains: [],
          timeoutMs: 30_000,
          memoryLimit: tightBytes,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // OOM, memory limit wrapper, or abrupt exit under resourceLimits
        assert.match(
          err.message,
          /MEMORY_LIMIT|heap|memory|out of memory|exited with code|ERR_WORKER/i,
        );
        return true;
      },
    );
  });
});

describe('runIsolated worker path (direct)', () => {
  it('network deny without going through HTTP', async () => {
    await assert.rejects(
      () =>
        runIsolated({
          extensionId: 'direct-net',
          inputs: { fetchUrl: 'https://x.test/' },
          network: false,
          approvedDomains: [],
          timeoutMs: 5000,
          memoryLimit: 128 * 1024 * 1024,
        }),
      /NETWORK_DENIED/,
    );
  });

  it('timeout without going through HTTP', async () => {
    await assert.rejects(
      () =>
        runIsolated({
          extensionId: 'direct-timeout',
          inputs: { sleepMs: 3000 },
          network: false,
          approvedDomains: [],
          timeoutMs: 200,
          memoryLimit: 128 * 1024 * 1024,
        }),
      /TIMEOUT/,
    );
  });
});

describe('health endpoints still public', () => {
  it('GET /health and /ready without token', async () => {
    const app = buildSandboxApp({ internalToken: TOKEN, logger: false });
    await app.ready();
    const h = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(h.statusCode, 200);
    assert.equal((h.json() as { service: string }).service, 'pgos-sandbox');
    const r = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(r.statusCode, 200);
    await app.close();
  });
});
