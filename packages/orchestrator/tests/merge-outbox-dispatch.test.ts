/**
 * H-02: merge-outbox dispatch envelope field completeness + no raw SSH in inputs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SecretEnvelope } from '@vibrato/shared';
import {
  buildMergeApplyDispatchEnvelope,
  resolveMergeServiceToken,
  type MergeOutboxDispatchDeps,
} from '../src/services/merge-outbox-dispatch.js';
import type { MergeOutboxPendingRow } from '../src/workers/merge-outbox-worker.js';
import { secretService } from '../src/services/secret-service.js';

function baseRow(over: Partial<MergeOutboxPendingRow> = {}): MergeOutboxPendingRow {
  return {
    id: 'outbox-abc',
    override_id: 'ov-1',
    project_id: '11111111-1111-1111-1111-111111111111',
    path: 'scenes/player.tscn',
    project_root: '/var/godot/projects/remote',
    patch: { nodes: [] },
    metadata: {
      targetHost: 'user@target.example',
      targetProvisionUrl: 'https://target.example/v1/provision',
    },
    introduces_script: false,
    ...over,
  };
}

function mockDeps(over: Partial<MergeOutboxDispatchDeps> = {}): MergeOutboxDispatchDeps {
  return {
    async createDirectDispatchJwe(secrets) {
      return {
        jwe: `jwe.mock.${Buffer.from(JSON.stringify(secrets)).toString('base64url')}`,
        envelope: { ...secrets, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      };
    },
    generateSshKey: () => ({
      publicKeyOpenSsh: 'ssh-ed25519 AAAA mock',
      privateKeyPem:
        '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
      keyId: 'key-1',
      expiresAt: new Date(Date.now() + 300_000),
    }),
    async provisionPublicKey() {
      return { ok: true, keyId: 'key-1', expiresAt: new Date().toISOString() };
    },
    getEnv: () =>
      ({
        PUBLIC_BASE_URL: 'https://pgos.example',
        SANDBOX_INTERNAL_TOKEN: 'dev-sandbox-token-long-enough',
        PGOS_PROVISION_MTLS_CERT: '',
        PGOS_PROVISION_MTLS_KEY: '',
        PGOS_PROVISION_MTLS_CA: '',
      }) as ReturnType<MergeOutboxDispatchDeps['getEnv']>,
    ...over,
  };
}

describe('merge-outbox-dispatch (H-02 envelope)', () => {
  it('resolveMergeServiceToken prefers PGOS_SERVICE_TOKEN', () => {
    assert.equal(
      resolveMergeServiceToken({
        PGOS_SERVICE_TOKEN: 'svc-token',
        SANDBOX_INTERNAL_TOKEN: 'sandbox',
      }),
      'svc-token',
    );
    assert.equal(
      resolveMergeServiceToken({ SANDBOX_INTERNAL_TOKEN: 'sandbox-only' }),
      'sandbox-only',
    );
  });

  it('workflow inputs include secretJwe and required identifiers (no raw PEM)', async () => {
    const envelope = await buildMergeApplyDispatchEnvelope({
      row: baseRow(),
      projectRoot: '/var/godot/projects/remote',
      patchGetUrl: 'https://s3.example/patch.json',
      s3Key: 'projects/p/merge-outbox/outbox-abc/patch.json',
      deps: mockDeps(),
    });

    const inputs = envelope.workflowInputs;
    assert.ok(inputs.secretJwe, 'secretJwe required');
    assert.equal(inputs.outboxId, 'outbox-abc');
    assert.equal(inputs.projectId, '11111111-1111-1111-1111-111111111111');
    assert.equal(inputs.path, 'scenes/player.tscn');
    assert.equal(inputs.projectRoot, '/var/godot/projects/remote');
    assert.equal(inputs.patchGetUrl, 'https://s3.example/patch.json');
    assert.equal(inputs.s3Key, 'projects/p/merge-outbox/outbox-abc/patch.json');

    // Completeness of sealed metadata
    assert.equal(envelope.sealed.hasSecretJwe, true);
    assert.equal(envelope.sealed.targetHost, 'user@target.example');
    assert.equal(envelope.sealed.hasSshPrivateKey, true);
    assert.equal(envelope.sealed.hasCallbackToken, true);
    assert.equal(envelope.sealed.pgosBaseUrl, 'https://pgos.example');
    assert.equal(envelope.sealed.relPath, 'scenes/player.tscn');
    assert.equal(envelope.sealed.outboxId, 'outbox-abc');

    // No raw private key outside secretJwe
    for (const [k, v] of Object.entries(inputs)) {
      if (k === 'secretJwe') continue;
      assert.doesNotMatch(v, /BEGIN .*PRIVATE KEY/);
    }
  });

  it('omits SSH provision when no provision URL (host-only metadata)', async () => {
    const envelope = await buildMergeApplyDispatchEnvelope({
      row: baseRow({
        metadata: { targetHost: 'user@host' },
      }),
      projectRoot: '/var/godot/p',
      patchGetUrl: 'https://s3.example/p',
      s3Key: 'k',
      deps: mockDeps(),
    });
    assert.equal(envelope.sealed.hasSshPrivateKey, false);
    assert.equal(envelope.sealed.targetHost, 'user@host');
    assert.ok(envelope.workflowInputs.secretJwe);
  });

  it('fails when provision returns error', async () => {
    await assert.rejects(
      () =>
        buildMergeApplyDispatchEnvelope({
          row: baseRow(),
          projectRoot: '/var/godot/p',
          patchGetUrl: 'https://s3.example/p',
          s3Key: 'k',
          deps: mockDeps({
            async provisionPublicKey() {
              return { ok: false, detail: 'mTLS missing' };
            },
          }),
        }),
      /SSH provision failed/,
    );
  });

  it('createDirectDispatchJwe round-trips via secretService.resolveDispatchJwe', async () => {
    // Avoid host env schema noise (e.g. invalid BOOTSTRAP_ADMIN_EMAIL in shell).
    const { resetEnvCache } = await import('../src/config/env.js');
    const prevEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const prevJwe = process.env.JWE_SECRET;
    const prevNode = process.env.NODE_ENV;
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
    process.env.JWE_SECRET = 'test-jwe-secret-for-merge-outbox-dispatch!!';
    process.env.NODE_ENV = 'test';
    resetEnvCache();
    try {
      const secrets: Omit<SecretEnvelope, 'expiresAt'> = {
        callbackToken: 'svc',
        targetHost: 'h',
        targetProjectRoot: '/p',
        outboxId: 'o1',
        relPath: 'a.tscn',
        pgosBaseUrl: 'http://localhost:8080',
        patchGetUrl: 'https://s3/x',
      };
      const { jwe } = await secretService.createDirectDispatchJwe(secrets, {
        purpose: 'merge-apply',
        ttlMs: 60_000,
      });
      const resolved = await secretService.resolveDispatchJwe(jwe);
      assert.ok(resolved);
      assert.equal(resolved.callbackToken, 'svc');
      assert.equal(resolved.targetHost, 'h');
      assert.equal(resolved.outboxId, 'o1');
      assert.equal(resolved.relPath, 'a.tscn');
      assert.equal(resolved.patchGetUrl, 'https://s3/x');
    } finally {
      if (prevEmail === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      else process.env.BOOTSTRAP_ADMIN_EMAIL = prevEmail;
      if (prevJwe === undefined) delete process.env.JWE_SECRET;
      else process.env.JWE_SECRET = prevJwe;
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      resetEnvCache();
    }
  });
});
