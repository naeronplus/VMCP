/**
 * JIT ephemeral SSH key provisioning for cross-machine commits (§4.2.1).
 *
 * Flow:
 * 1. Runner (or orchestrator) generates ed25519 keypair.
 * 2. Public key is POSTed to target provision endpoint (mTLS/VPN).
 * 3. Target writes single-use authorized_keys entry with forced command.
 * 4. Private key is sealed into JWE secret envelope for the worker.
 * 5. After one login (or TTL), public key is purged.
 */
import crypto from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { audit } from './audit-service.js';

export interface EphemeralSshKey {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
  keyId: string;
  expiresAt: Date;
}

export function generateEphemeralEd25519(): EphemeralSshKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = publicKeyDer.subarray(publicKeyDer.length - 32);
  const publicKeyOpenSsh = encodeOpenSSHEd25519(raw);

  return {
    publicKeyOpenSsh,
    privateKeyPem,
    keyId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
}

/**
 * Call target machine provisioning endpoint to install single-login authorized_keys.
 */
export async function provisionPublicKey(opts: {
  targetProvisionUrl: string;
  publicKeyOpenSsh: string;
  forcedCommand: string;
  jobId: string;
  mtlsCert?: string;
  mtlsKey?: string;
}): Promise<{ ok: boolean; detail?: string }> {
  const env = getEnv();
  try {
    const res = await fetch(opts.targetProvisionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SANDBOX_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        publicKey: opts.publicKeyOpenSsh,
        forcedCommand: opts.forcedCommand,
        jobId: opts.jobId,
        singleUse: true,
        ttlSeconds: 300,
      }),
    });
    await audit({
      action: 'ssh.jit_provisioned',
      resourceType: 'job',
      resourceId: opts.jobId,
      detail: { target: opts.targetProvisionUrl, status: res.status },
    });
    if (!res.ok) {
      return { ok: false, detail: await res.text() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * 90-day secret rotation cron target (§4.2.2).
 */
/** OpenSSH wire format: string type + string key blob (RFC 4253 §6.6). */
function encodeOpenSSHEd25519(rawPubKey: Buffer): string {
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.alloc(4 + type.length + 4 + rawPubKey.length);
  let offset = 0;
  blob.writeUInt32BE(type.length, offset);
  offset += 4;
  type.copy(blob, offset);
  offset += type.length;
  blob.writeUInt32BE(rawPubKey.length, offset);
  offset += 4;
  rawPubKey.copy(blob, offset);
  return `ssh-ed25519 ${blob.toString('base64')} pgos-ephemeral`;
}

export async function rotateAgentSecrets(targetRotateUrl: string): Promise<void> {
  const env = getEnv();
  await fetch(targetRotateUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SANDBOX_INTERNAL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'rotate-mtls', periodDays: 90 }),
  });
  await audit({
    action: 'agent.secrets_rotated',
    resourceType: 'commit-agent',
    resourceId: targetRotateUrl,
    detail: { periodDays: 90 },
  });
}
