/**
 * JIT ephemeral SSH key provisioning for cross-machine commits (§4.2.1 / DEP-01).
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
 *
 * Auth (SEC-02): PGOS_PROVISION_TOKEN preferred; SANDBOX_INTERNAL_TOKEN fallback
 * with deprecation warning only.
 *
 * Transport (SEC-01): optional client mTLS via PGOS_PROVISION_MTLS_CERT/KEY(/CA)
 * PEM file paths — preferred over bearer-only in production checklists.
 */
import crypto from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { getEnv } from '../config/env.js';
import { audit } from './audit-service.js';

export interface EphemeralSshKey {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
  keyId: string;
  expiresAt: Date;
}

export type ProvisionEnvironment = Record<string, string>;

export interface ProvisionMtlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  certPath: string;
  keyPath: string;
  caPath?: string;
}

let warnedSandboxTokenFallback = false;

/**
 * Resolve bearer for target provisioner (SEC-02).
 * Prefer PGOS_PROVISION_TOKEN; fall back to SANDBOX_INTERNAL_TOKEN with warning.
 */
export function resolveProvisionBearerToken(env: {
  PGOS_PROVISION_TOKEN?: string;
  SANDBOX_INTERNAL_TOKEN: string;
  NODE_ENV?: string;
}): { token: string; usedFallback: boolean } {
  const dedicated = (env.PGOS_PROVISION_TOKEN ?? '').trim();
  if (dedicated) {
    return { token: dedicated, usedFallback: false };
  }
  return { token: env.SANDBOX_INTERNAL_TOKEN, usedFallback: true };
}

/**
 * Load client mTLS PEMs from disk (SEC-01).
 * Returns null when neither path is set. Throws when only one of cert/key is set
 * or when files are missing.
 */
export function loadProvisionMtlsMaterial(opts: {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
}): ProvisionMtlsMaterial | null {
  const certPath = (opts.certPath ?? '').trim();
  const keyPath = (opts.keyPath ?? '').trim();
  const caPath = (opts.caPath ?? '').trim();
  if (!certPath && !keyPath) {
    return null;
  }
  if (!certPath || !keyPath) {
    throw new Error(
      'PGOS_PROVISION_MTLS_CERT and PGOS_PROVISION_MTLS_KEY must both be set (SEC-01)',
    );
  }
  if (!existsSync(certPath)) {
    throw new Error(`PGOS_PROVISION_MTLS_CERT not found: ${certPath}`);
  }
  if (!existsSync(keyPath)) {
    throw new Error(`PGOS_PROVISION_MTLS_KEY not found: ${keyPath}`);
  }
  if (caPath && !existsSync(caPath)) {
    throw new Error(`PGOS_PROVISION_MTLS_CA not found: ${caPath}`);
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: caPath ? readFileSync(caPath) : undefined,
    certPath,
    keyPath,
    caPath: caPath || undefined,
  };
}

/**
 * Resolve mTLS paths from env and optional per-call overrides (job-service / metadata later).
 */
export function resolveProvisionMtlsPaths(env: {
  PGOS_PROVISION_MTLS_CERT?: string;
  PGOS_PROVISION_MTLS_KEY?: string;
  PGOS_PROVISION_MTLS_CA?: string;
}, overrides?: {
  mtlsCert?: string;
  mtlsKey?: string;
  mtlsCa?: string;
}): { certPath: string; keyPath: string; caPath: string } {
  return {
    certPath: (overrides?.mtlsCert ?? env.PGOS_PROVISION_MTLS_CERT ?? '').trim(),
    keyPath: (overrides?.mtlsKey ?? env.PGOS_PROVISION_MTLS_KEY ?? '').trim(),
    caPath: (overrides?.mtlsCa ?? env.PGOS_PROVISION_MTLS_CA ?? '').trim(),
  };
}

/**
 * HTTP(S) POST with optional client certificates (SEC-01).
 * Uses node:https Agent when mTLS material is present; plain fetch otherwise.
 */
export async function provisionHttpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  mtls: ProvisionMtlsMaterial | null,
): Promise<{ status: number; bodyText: string }> {
  if (!mtls) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    return { status: res.status, bodyText };
  }

  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps
      ? new https.Agent({
          cert: mtls.cert,
          key: mtls.key,
          ca: mtls.ca,
          rejectUnauthorized: true,
        })
      : undefined;

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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
  /** Optional overrides (prefer env; job-service may pass through metadata later). */
  mtlsCert?: string;
  mtlsKey?: string;
  mtlsCa?: string;
}): Promise<{ ok: boolean; detail?: string; keyId?: string; expiresAt?: string }> {
  const env = getEnv();
  const ttlSeconds = opts.ttlSeconds ?? 300;
  const maxSessions = opts.maxSessions ?? 8;
  const { token, usedFallback } = resolveProvisionBearerToken(env);
  if (usedFallback && !warnedSandboxTokenFallback) {
    warnedSandboxTokenFallback = true;
    console.warn(
      '[ssh-provision] PGOS_PROVISION_TOKEN unset; falling back to SANDBOX_INTERNAL_TOKEN (deprecated for provision auth — set PGOS_PROVISION_TOKEN)',
    );
  }

  let mtls: ProvisionMtlsMaterial | null = null;
  try {
    const paths = resolveProvisionMtlsPaths(env, {
      mtlsCert: opts.mtlsCert,
      mtlsKey: opts.mtlsKey,
      mtlsCa: opts.mtlsCa,
    });
    mtls = loadProvisionMtlsMaterial(paths);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }

  const payload = JSON.stringify({
    publicKey: opts.publicKeyOpenSsh,
    forcedCommand: opts.forcedCommand,
    jobId: opts.jobId,
    // Multi-session within TTL — ForcedCommand pipeline needs stage+commit+verify(+restore)
    singleUse: false,
    maxSessions,
    ttlSeconds,
    environment: opts.environment ?? {},
  });

  try {
    const { status, bodyText } = await provisionHttpPost(
      opts.targetProvisionUrl,
      payload,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      mtls,
    );
    let parsed: { keyId?: string; expiresAt?: string; ok?: boolean } = {};
    try {
      parsed = bodyText ? (JSON.parse(bodyText) as typeof parsed) : {};
    } catch {
      /* non-JSON error body */
    }
    await safeAudit({
      action: 'ssh.jit_provisioned',
      resourceType: 'job',
      resourceId: opts.jobId,
      detail: {
        target: opts.targetProvisionUrl,
        status,
        singleUse: false,
        maxSessions,
        ttlSeconds,
        environmentKeys: Object.keys(opts.environment ?? {}),
        provisionAuth: usedFallback ? 'sandbox_token_fallback' : 'pgos_provision_token',
        mtls: Boolean(mtls),
        keyId: parsed.keyId,
      },
    });
    if (status < 200 || status >= 300) {
      return { ok: false, detail: bodyText || `HTTP ${status}` };
    }
    return {
      ok: true,
      keyId: parsed.keyId,
      expiresAt: parsed.expiresAt,
    };
  } catch (err) {
    await safeAudit({
      action: 'ssh.jit_provisioned',
      resourceType: 'job',
      resourceId: opts.jobId,
      detail: {
        target: opts.targetProvisionUrl,
        status: 0,
        error: (err as Error).message,
        mtls: Boolean(mtls),
      },
    });
    return { ok: false, detail: (err as Error).message };
  }
}

async function safeAudit(input: Parameters<typeof audit>[0]): Promise<void> {
  try {
    await audit(input);
  } catch (err) {
    // Provision must not fail solely because audit sink is down (tests, DB blip).
    console.warn('[ssh-provision] audit failed:', (err as Error).message);
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
  const { token } = resolveProvisionBearerToken(env);
  const paths = resolveProvisionMtlsPaths(env);
  let mtls: ProvisionMtlsMaterial | null = null;
  try {
    mtls = loadProvisionMtlsMaterial(paths);
  } catch (err) {
    console.warn('[ssh-provision] rotate mTLS load failed:', (err as Error).message);
  }
  await provisionHttpPost(
    targetRotateUrl,
    JSON.stringify({ action: 'rotate-mtls', periodDays: 90 }),
    {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    mtls,
  );
  await safeAudit({
    action: 'agent.secrets_rotated',
    resourceType: 'commit-agent',
    resourceId: targetRotateUrl,
    detail: { periodDays: 90, mtls: Boolean(mtls) },
  });
}
