/**
 * SEC-01: mTLS material loader + client cert presentation to mock HTTPS provisioner.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  loadProvisionMtlsMaterial,
  provisionHttpPost,
  resolveProvisionMtlsPaths,
} from '../src/services/ssh-provision.js';

function opensslAvailable(): boolean {
  try {
    const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function writeOpensslSelfSigned(dir: string, name: string): { cert: string; key: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  // Include IP SAN so https.Agent rejectUnauthorized accepts 127.0.0.1
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-nodes',
      '-subj',
      `/CN=pgos-${name}`,
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`openssl failed: ${r.stderr}`);
  }
  return { cert, key };
}

describe('ssh-provision mTLS (SEC-01)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgos-mtls-'));
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('loadProvisionMtlsMaterial returns null when paths empty', () => {
    assert.equal(loadProvisionMtlsMaterial({}), null);
    assert.equal(loadProvisionMtlsMaterial({ certPath: '', keyPath: '' }), null);
  });

  it('loadProvisionMtlsMaterial throws when only one path set', () => {
    assert.throws(
      () => loadProvisionMtlsMaterial({ certPath: '/tmp/a.crt' }),
      /both be set/,
    );
  });

  it('loadProvisionMtlsMaterial throws when files missing', () => {
    assert.throws(
      () =>
        loadProvisionMtlsMaterial({
          certPath: join(dir, 'missing.crt'),
          keyPath: join(dir, 'missing.key'),
        }),
      /not found/,
    );
  });

  it('resolveProvisionMtlsPaths prefers overrides over env', () => {
    const p = resolveProvisionMtlsPaths(
      {
        PGOS_PROVISION_MTLS_CERT: '/env/c.pem',
        PGOS_PROVISION_MTLS_KEY: '/env/k.pem',
        PGOS_PROVISION_MTLS_CA: '/env/ca.pem',
      },
      { mtlsCert: '/ov/c.pem', mtlsKey: '/ov/k.pem' },
    );
    assert.equal(p.certPath, '/ov/c.pem');
    assert.equal(p.keyPath, '/ov/k.pem');
    assert.equal(p.caPath, '/env/ca.pem');
  });

  it(
    'loadProvisionMtlsMaterial reads PEM files when openssl available',
    { skip: !opensslAvailable() },
    () => {
      const { cert, key } = writeOpensslSelfSigned(dir, 'loader');
      const mat = loadProvisionMtlsMaterial({ certPath: cert, keyPath: key });
      assert.ok(mat);
      assert.ok(mat!.cert.length > 0);
      assert.ok(mat!.key.length > 0);
      assert.equal(mat!.certPath, cert);
    },
  );

  it(
    'provisionHttpPost presents client cert to HTTPS mock',
    { skip: !opensslAvailable() },
    async () => {
      const { cert, key } = writeOpensslSelfSigned(dir, 'peer');
      const mat = loadProvisionMtlsMaterial({
        certPath: cert,
        keyPath: key,
        caPath: cert, // self-signed: trust same cert as CA for server
      });
      assert.ok(mat);

      let sawPeerCert = false;
      const server = https.createServer(
        {
          cert: mat!.cert,
          key: mat!.key,
          requestCert: true,
          rejectUnauthorized: false,
          ca: mat!.cert,
        },
        (req, res) => {
          const peer = (req.socket as TLSSocket).getPeerCertificate();
          sawPeerCert = Boolean(peer && (peer as { fingerprint?: string }).fingerprint);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, keyId: 'mtls-1' }));
        },
      );

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const url = `https://127.0.0.1:${addr.port}/v1/provision`;

      try {
        const { status, bodyText } = await provisionHttpPost(
          url,
          JSON.stringify({ publicKey: 'ssh-ed25519 AAAA test' }),
          { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          mat,
        );
        assert.equal(status, 201);
        assert.match(bodyText, /mtls-1/);
        assert.equal(sawPeerCert, true, 'server must observe client certificate');
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
  );
});
