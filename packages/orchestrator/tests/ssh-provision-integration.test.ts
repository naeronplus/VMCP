/**
 * DEP-01 / SEC-02: orchestrator client → mock target provisioner.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  generateEphemeralEd25519,
  provisionPublicKey,
  resolveProvisionBearerToken,
  resolveCrossMachineProvision,
} from '../src/services/ssh-provision.js';
import { getEnv, resetEnvCache } from '../src/config/env.js';

const savedEnv: Record<string, string | undefined> = {};

function stashEnv(keys: string[]) {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
  }
}

function restoreEnv(keys: string[]) {
  for (const k of keys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function ensureTestEnv() {
  // Valid minimal env so getEnv() can parse (avoids BOOTSTRAP_ADMIN_EMAIL email validation errors)
  process.env.NODE_ENV = 'test';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
  process.env.SANDBOX_INTERNAL_TOKEN =
    process.env.SANDBOX_INTERNAL_TOKEN || 'sandbox-fallback-token';
  process.env.PGOS_PROVISION_TOKEN = 'dedicated-provision-token';
  process.env.JWE_SECRET = 'test-jwe-secret-32chars-minimum-value!!';
  resetEnvCache();
}

describe('ssh-provision integration (DEP-01)', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastAuth: string | undefined;
  let lastBody: Record<string, unknown> | undefined;
  let statusCode = 201;

  const envKeys = [
    'NODE_ENV',
    'BOOTSTRAP_ADMIN_EMAIL',
    'SANDBOX_INTERNAL_TOKEN',
    'PGOS_PROVISION_TOKEN',
    'JWE_SECRET',
  ];

  before(async () => {
    stashEnv(envKeys);
    server = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        try {
          lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
        } catch {
          lastBody = undefined;
        }
        if (req.url === '/v1/provision' && req.method === 'POST') {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          if (statusCode === 201) {
            res.end(
              JSON.stringify({
                ok: true,
                keyId: 'mock-key-1',
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              }),
            );
          } else {
            res.end(JSON.stringify({ error: 'mock failure' }));
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    baseUrl = `http://127.0.0.1:${addr.port}/v1/provision`;
  });

  after(async () => {
    restoreEnv(envKeys);
    resetEnvCache();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    statusCode = 201;
    lastAuth = undefined;
    lastBody = undefined;
    ensureTestEnv();
  });

  afterEach(() => {
    resetEnvCache();
  });

  it('resolveProvisionBearerToken prefers PGOS_PROVISION_TOKEN (SEC-02)', () => {
    const r = resolveProvisionBearerToken({
      PGOS_PROVISION_TOKEN: 'prov',
      SANDBOX_INTERNAL_TOKEN: 'sandbox',
    });
    assert.equal(r.token, 'prov');
    assert.equal(r.usedFallback, false);
  });

  it('resolveProvisionBearerToken falls back to SANDBOX_INTERNAL_TOKEN', () => {
    const r = resolveProvisionBearerToken({
      PGOS_PROVISION_TOKEN: '',
      SANDBOX_INTERNAL_TOKEN: 'sandbox',
    });
    assert.equal(r.token, 'sandbox');
    assert.equal(r.usedFallback, true);
  });

  it('POSTs singleUse:false + environment + dedicated bearer to mock provisioner', async () => {
    const ssh = generateEphemeralEd25519();
    const result = await provisionPublicKey({
      targetProvisionUrl: baseUrl,
      publicKeyOpenSsh: ssh.publicKeyOpenSsh,
      forcedCommand: 'commit-agent-once',
      jobId: 'job-int-1',
      environment: {
        PGOS_LOCK_KEY: 'gen:p1',
        PGOS_LOCK_OWNER: 'job:job-int-1',
        PGOS_JOB_ID: 'job-int-1',
        PGOS_REQUIRE_FENCING: 'true',
      },
      maxSessions: 8,
      ttlSeconds: 300,
    });
    assert.equal(result.ok, true);
    assert.equal(result.keyId, 'mock-key-1');
    assert.equal(lastAuth, 'Bearer dedicated-provision-token');
    assert.ok(lastBody);
    assert.equal(lastBody.singleUse, false);
    assert.equal(lastBody.forcedCommand, 'commit-agent-once');
    assert.equal(lastBody.jobId, 'job-int-1');
    assert.equal(lastBody.maxSessions, 8);
    assert.equal(lastBody.ttlSeconds, 300);
    assert.equal(typeof lastBody.publicKey, 'string');
    assert.match(String(lastBody.publicKey), /^ssh-ed25519 /);
    const envMap = lastBody.environment as Record<string, string>;
    assert.equal(envMap.PGOS_REQUIRE_FENCING, 'true');
    assert.equal(envMap.PGOS_LOCK_OWNER, 'job:job-int-1');
  });

  it('returns ok:false when provisioner responds non-2xx', async () => {
    statusCode = 401;
    const ssh = generateEphemeralEd25519();
    const result = await provisionPublicKey({
      targetProvisionUrl: baseUrl,
      publicKeyOpenSsh: ssh.publicKeyOpenSsh,
      forcedCommand: 'commit-agent-once',
      jobId: 'job-int-fail',
    });
    assert.equal(result.ok, false);
    assert.match(String(result.detail), /401|unauthorized|mock/i);
  });

  it('falls back to sandbox token when PGOS_PROVISION_TOKEN empty', async () => {
    delete process.env.PGOS_PROVISION_TOKEN;
    process.env.SANDBOX_INTERNAL_TOKEN = 'sandbox-only-token';
    process.env.NODE_ENV = 'test';
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
    resetEnvCache();
    assert.equal(getEnv().SANDBOX_INTERNAL_TOKEN, 'sandbox-only-token');
    assert.equal((getEnv().PGOS_PROVISION_TOKEN ?? '').trim(), '');

    const ssh = generateEphemeralEd25519();
    const result = await provisionPublicKey({
      targetProvisionUrl: baseUrl,
      publicKeyOpenSsh: ssh.publicKeyOpenSsh,
      forcedCommand: 'commit-agent-once',
      jobId: 'job-fallback',
    });
    assert.equal(result.ok, true);
    assert.equal(lastAuth, 'Bearer sandbox-only-token');
  });

  it('resolveCrossMachineProvision requires targetProvisionUrl pointing at /v1/provision style URL', () => {
    const r = resolveCrossMachineProvision('cross-machine', {
      targetHost: 'godot@target.internal',
      targetProvisionUrl: 'https://target.internal:9071/v1/provision',
    });
    assert.equal(r.action, 'provision');
    if (r.action === 'provision') {
      assert.equal(r.provisionUrl, 'https://target.internal:9071/v1/provision');
    }
  });
});
