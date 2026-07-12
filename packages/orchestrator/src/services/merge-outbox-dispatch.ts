/**
 * H-02: Build merge_apply.yml workflow_dispatch inputs with secretJwe only
 * for SSH / callback material (never raw private keys in workflow inputs).
 */
import type { SecretEnvelope } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { secretService } from './secret-service.js';
import {
  generateEphemeralEd25519,
  provisionPublicKey,
} from './ssh-provision.js';
import type { MergeOutboxPendingRow } from '../workers/merge-outbox-worker.js';

export type MergeApplyDispatchEnvelope = {
  /** String map for GitHub Actions workflow_dispatch (no raw SSH). */
  workflowInputs: Record<string, string>;
  /** Sealed secrets (for tests / audit — do not log sshPrivateKey). */
  sealed: {
    hasSecretJwe: true;
    targetHost?: string;
    projectRoot: string;
    outboxId: string;
    relPath: string;
    patchGetUrl: string;
    hasSshPrivateKey: boolean;
    hasCallbackToken: boolean;
    pgosBaseUrl: string;
  };
};

export type MergeOutboxDispatchDeps = {
  createDirectDispatchJwe: (
    secrets: Omit<SecretEnvelope, 'expiresAt'>,
    opts?: { purpose?: string; ttlMs?: number },
  ) => Promise<{ jwe: string; envelope: SecretEnvelope }>;
  generateSshKey: () => ReturnType<typeof generateEphemeralEd25519>;
  provisionPublicKey: typeof provisionPublicKey;
  getEnv: typeof getEnv;
};

export function createDefaultMergeOutboxDispatchDeps(): MergeOutboxDispatchDeps {
  return {
    createDirectDispatchJwe: (secrets, opts) =>
      secretService.createDirectDispatchJwe(secrets, opts),
    generateSshKey: () => generateEphemeralEd25519(),
    provisionPublicKey,
    getEnv,
  };
}

function metaString(
  meta: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve service token used for POST /merge-outbox/:id/complete.
 * Prefer PGOS_SERVICE_TOKEN; fall back to SANDBOX_INTERNAL_TOKEN for dev.
 */
export function resolveMergeServiceToken(env: {
  PGOS_SERVICE_TOKEN?: string;
  SANDBOX_INTERNAL_TOKEN?: string;
}): string {
  const dedicated = (env.PGOS_SERVICE_TOKEN ?? '').trim();
  if (dedicated) return dedicated;
  return (env.SANDBOX_INTERNAL_TOKEN ?? '').trim();
}

/**
 * Build remote merge-apply dispatch: JWE envelope + non-secret workflow inputs.
 *
 * Workflow inputs (safe):
 *   secretJwe, outboxId, projectId, path, projectRoot, patchGetUrl, s3Key
 *
 * Sealed in secretJwe (SecretEnvelope):
 *   callbackToken, targetHost, targetProjectRoot, sshPrivateKey?, outboxId,
 *   relPath, pgosBaseUrl, patchGetUrl
 */
export async function buildMergeApplyDispatchEnvelope(opts: {
  row: MergeOutboxPendingRow;
  projectRoot: string;
  patchGetUrl: string;
  s3Key: string;
  deps?: MergeOutboxDispatchDeps;
}): Promise<MergeApplyDispatchEnvelope> {
  const deps = opts.deps ?? createDefaultMergeOutboxDispatchDeps();
  const env = deps.getEnv();
  const meta =
    opts.row.metadata && typeof opts.row.metadata === 'object'
      ? opts.row.metadata
      : {};

  const targetHost = metaString(meta, 'targetHost', 'target_host');
  const provisionUrl = metaString(
    meta,
    'targetProvisionUrl',
    'target_provision_url',
  );
  // PGOS_SERVICE_TOKEN lands in env schema in ENV-02; accept process.env until then.
  const callbackToken = resolveMergeServiceToken({
    PGOS_SERVICE_TOKEN:
      process.env.PGOS_SERVICE_TOKEN ??
      (env as { PGOS_SERVICE_TOKEN?: string }).PGOS_SERVICE_TOKEN,
    SANDBOX_INTERNAL_TOKEN: env.SANDBOX_INTERNAL_TOKEN,
  });
  if (!callbackToken) {
    throw new Error(
      'PGOS_SERVICE_TOKEN (or SANDBOX_INTERNAL_TOKEN) required for remote merge-apply JWE',
    );
  }

  const pgosBaseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const secrets: Omit<SecretEnvelope, 'expiresAt'> = {
    callbackToken,
    targetProjectRoot: opts.projectRoot,
    targetHost,
    outboxId: opts.row.id,
    relPath: opts.row.path,
    pgosBaseUrl,
    patchGetUrl: opts.patchGetUrl,
  };

  // JIT SSH when provision URL is configured (mirrors job-service cross-machine).
  if (provisionUrl && targetHost) {
    const ssh = deps.generateSshKey();
    const provision = await deps.provisionPublicKey({
      targetProvisionUrl: provisionUrl,
      publicKeyOpenSsh: ssh.publicKeyOpenSsh,
      forcedCommand: 'commit-agent-once',
      jobId: `merge-outbox:${opts.row.id}`,
      environment: {
        PGOS_OUTBOX_ID: opts.row.id,
        PGOS_PROJECT_ID: opts.row.project_id,
        PGOS_REQUIRE_FENCING: 'false',
      },
      maxSessions: 4,
      ttlSeconds: 300,
      mtlsCert: env.PGOS_PROVISION_MTLS_CERT || undefined,
      mtlsKey: env.PGOS_PROVISION_MTLS_KEY || undefined,
      mtlsCa: env.PGOS_PROVISION_MTLS_CA || undefined,
    });
    if (!provision.ok) {
      throw new Error(
        `merge-apply SSH provision failed: ${provision.detail ?? 'unknown'}`,
      );
    }
    secrets.sshPrivateKey = ssh.privateKeyPem;
    secrets.sshKeyId = ssh.keyId;
  }

  const { jwe } = await deps.createDirectDispatchJwe(secrets, {
    purpose: 'merge-apply',
    ttlMs: 3_600_000,
  });

  // Workflow_dispatch: secretJwe only for secrets; identifiers for runner UX/logs.
  const workflowInputs: Record<string, string> = {
    secretJwe: jwe,
    outboxId: opts.row.id,
    projectId: opts.row.project_id,
    path: opts.row.path,
    projectRoot: opts.projectRoot,
    patchGetUrl: opts.patchGetUrl,
    s3Key: opts.s3Key,
  };

  // Guard: never put PEM material in workflow inputs
  for (const [k, v] of Object.entries(workflowInputs)) {
    if (k === 'secretJwe') continue;
    if (/BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/i.test(v)) {
      throw new Error(`refusing to put private key material in workflow input ${k}`);
    }
  }

  return {
    workflowInputs,
    sealed: {
      hasSecretJwe: true,
      targetHost,
      projectRoot: opts.projectRoot,
      outboxId: opts.row.id,
      relPath: opts.row.path,
      patchGetUrl: opts.patchGetUrl,
      hasSshPrivateKey: Boolean(secrets.sshPrivateKey),
      hasCallbackToken: Boolean(callbackToken),
      pgosBaseUrl,
    },
  };
}
