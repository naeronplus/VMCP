/**
 * JIT ephemeral SSH key provisioning for cross-machine commits (§4.2.1).
 *
 * Flow:
 * 1. Runner (or orchestrator) generates ed25519 keypair.
 * 2. Public key is POSTed to target provision endpoint (mTLS/VPN).
 * 3. Target writes multi-session (TTL-bound) authorized_keys entry with:
 *    - ForcedCommand=commit-agent-once
 *    - environment="PGOS_LOCK_KEY=…,PGOS_LOCK_OWNER=job:…,…"
 * 4. Private key is sealed into JWE secret envelope for the worker.
 * 5. After TTL (or explicit revoke), public key is purged.
 *
 * Target provisioner MUST honor:
 * - singleUse: false + maxSessions (multi round-trip: stage/commit/reimport/restore)
 * - environment map → OpenSSH authorized_keys environment="K=V,K2=V2"
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

export type ProvisionEnvironment = Record<string, string>;

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
 * Call target machine provisioning endpoint to install TTL-bound authorized_keys.
 */
export async function provisionPublicKey(opts: {
  targetProvisionUrl: string;
  publicKeyOpenSsh: string;
  forcedCommand: string;
  jobId: string;
  environment?: ProvisionEnvironment;
  maxSessions?: number;
  ttlSeconds?: number;
  mtlsCert?: string;
  mtlsKey?: string;
}): Promise<{ ok: boolean; detail?: string }> {
  const env = getEnv();
  const ttlSeconds = opts.ttlSeconds ?? 300;
  const maxSessions = opts.maxSessions ?? 8;
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
        // Multi-session within TTL — ForcedCommand pipeline needs stage+commit+verify(+restore)
        singleUse: false,
        maxSessions,
        ttlSeconds,
        environment: opts.environment ?? {},
      }),
    });
    await audit({
      action: 'ssh.jit_provisioned',
      resourceType: 'job',
      resourceId: opts.jobId,
      detail: {
        target: opts.targetProvisionUrl,
        status: res.status,
        singleUse: false,
        maxSessions,
        ttlSeconds,
        environmentKeys: Object.keys(opts.environment ?? {}),
      },
    });
    if (!res.ok) {
      return { ok: false, detail: await res.text() };
    }
    return { ok: true };
  } catch (err) {
    await audit({
      action: 'ssh.jit_provisioned',
      resourceType: 'job',
      resourceId: opts.jobId,
      detail: {
        target: opts.targetProvisionUrl,
        status: 0,
        error: (err as Error).message,
      },
    });
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Decide whether cross-machine dispatch may proceed to SSH provision.
 * Pure helper for unit tests + job-service.
 */
export function resolveCrossMachineProvision(
  commitStrategy: string,
  metadata: Record<string, unknown> | null | undefined,
):
  | { action: 'not-cross-machine' }
  | { action: 'provision'; targetHost: string; provisionUrl: string }
  | { action: 'fail'; detail: string } {
  if (commitStrategy !== 'cross-machine') {
    return { action: 'not-cross-machine' };
  }
  const targetHost = metadata?.targetHost;
  const provisionUrl = metadata?.targetProvisionUrl;
  const host =
    typeof targetHost === 'string' && targetHost.trim() ? targetHost.trim() : '';
  const url =
    typeof provisionUrl === 'string' && provisionUrl.trim() ? provisionUrl.trim() : '';
  if (!host && !url) {
    return {
      action: 'fail',
      detail:
        'cross-machine requires metadata.targetHost and metadata.targetProvisionUrl',
    };
  }
  if (!host) {
    return { action: 'fail', detail: 'cross-machine requires metadata.targetHost' };
  }
  if (!url) {
    return {
      action: 'fail',
      detail: 'cross-machine requires metadata.targetProvisionUrl',
    };
  }
  return { action: 'provision', targetHost: host, provisionUrl: url };
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
