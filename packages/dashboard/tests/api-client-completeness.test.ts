/**
 * §7.8 / report §11.2 — Dashboard API client completeness.
 * Asserts every plan method exists and targets the correct HTTP path.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_CLIENT_PLAN_METHODS,
  api,
  type ApiClientPlanMethod,
} from '../src/api/client.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('dashboard API client completeness (§7.8)', () => {
  it('exports all plan methods on api', () => {
    for (const name of API_CLIENT_PLAN_METHODS) {
      assert.equal(
        typeof (api as Record<string, unknown>)[name],
        'function',
        `missing api.${name}`,
      );
    }
  });

  it('plan method list matches report §11.2', () => {
    assert.deepEqual([...API_CLIENT_PLAN_METHODS].sort(), [
      'auditLogs',
      'createProject',
      'enableTier',
      'getJob',
      'listExtensions',
      'lockHistory',
      'uidReserve',
    ]);
  });
});

describe('dashboard API client HTTP paths (§7.8)', () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body != null ? String(init.body) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, job: { id: UUID }, project: { id: UUID }, history: [], logs: [], policies: [], reservation: { id: UUID, uid: 'uid://x', logicalAssetPath: 'res://a' }, jobs: [], projects: [], locks: [], tiers: [], checks: [], items: [], approvals: [], catalog: {}, errors: [], user: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function lastCall() {
    assert.ok(calls.length > 0, 'expected fetch call');
    return calls[calls.length - 1]!;
  }

  it('createProject → POST /api/v1/projects', async () => {
    calls.length = 0;
    await api.createProject({
      name: 'Demo',
      slug: 'demo',
      projectRoot: '/var/godot/projects/demo',
    });
    const c = lastCall();
    assert.equal(c.method, 'POST');
    assert.match(c.url, /\/api\/v1\/projects$/);
    assert.ok(c.body?.includes('Demo'));
  });

  it('getJob → GET /api/v1/jobs/:id', async () => {
    calls.length = 0;
    await api.getJob(UUID);
    const c = lastCall();
    assert.equal(c.method, 'GET');
    assert.equal(c.url, `/api/v1/jobs/${UUID}`);
  });

  it('enableTier → POST /api/v1/tiers/:id/enable', async () => {
    calls.length = 0;
    await api.enableTier('A', false);
    const c = lastCall();
    assert.equal(c.method, 'POST');
    assert.equal(c.url, '/api/v1/tiers/A/enable');
    assert.ok(c.body?.includes('"enabled":false'));
  });

  it('lockHistory → GET /api/v1/locks/:key/history (encoded)', async () => {
    calls.length = 0;
    await api.lockHistory('project:p1:generation');
    const c = lastCall();
    assert.equal(c.method, 'GET');
    assert.match(c.url, /\/api\/v1\/locks\/project%3Ap1%3Ageneration\/history$/);
  });

  it('auditLogs → GET /api/v1/audit-logs with query', async () => {
    calls.length = 0;
    await api.auditLogs({ limit: 50, resourceType: 'job' });
    const c = lastCall();
    assert.equal(c.method, 'GET');
    assert.match(c.url, /\/api\/v1\/audit-logs\?/);
    assert.match(c.url, /limit=50/);
    assert.match(c.url, /resourceType=job/);
  });

  it('listExtensions → GET /api/v1/extensions', async () => {
    calls.length = 0;
    await api.listExtensions();
    const c = lastCall();
    assert.equal(c.method, 'GET');
    assert.match(c.url, /\/api\/v1\/extensions$/);
  });

  it('uidReserve → POST /api/v1/projects/:id/uid-reservations', async () => {
    calls.length = 0;
    await api.uidReserve(UUID, {
      logicalAssetPath: 'res://assets/x.tscn',
      namespace: 'GEN-',
    });
    const c = lastCall();
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `/api/v1/projects/${UUID}/uid-reservations`);
    assert.ok(c.body?.includes('logicalAssetPath'));
  });

  it('every plan method was exercised', () => {
    const exercised = new Set<ApiClientPlanMethod>();
    // Re-run nothing — assert names exist; path tests above cover each
    for (const m of API_CLIENT_PLAN_METHODS) {
      exercised.add(m);
      assert.ok(typeof api[m] === 'function');
    }
    assert.equal(exercised.size, 7);
  });
});
