import type { Env } from './env.js';

const INSECURE_JWE_DEFAULT = 'change-me-to-a-32-byte-or-longer-secret!!';
const INSECURE_SANDBOX_DEFAULT = 'dev-sandbox-token';
/** .env.example / local compose default — never use as production provision token. */
const INSECURE_PROVISION_DEFAULT = 'dev-provision-token';

function hasRs256Keys(env: Env): boolean {
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) return true;
  if (env.JWT_PRIVATE_KEY_PATH && env.JWT_PUBLIC_KEY_PATH) return true;
  return false;
}

function isDefaultSecret(value: string, defaultValue: string): boolean {
  return value === defaultValue;
}

/**
 * SEC-02: dedicated provision credential must not couple to sandbox token/defaults.
 * Exported for unit tests.
 */
export function validateProvisionTokenProduction(
  provisionToken: string | undefined,
  sandboxToken: string,
): string[] {
  const errors: string[] = [];
  const prov = (provisionToken ?? '').trim();
  const sandbox = (sandboxToken ?? '').trim();

  if (!prov) {
    errors.push(
      'PGOS_PROVISION_TOKEN is required in production (SEC-02 — dedicated target provisioner bearer; do not reuse SANDBOX_INTERNAL_TOKEN)',
    );
    return errors;
  }
  if (isDefaultSecret(prov, INSECURE_SANDBOX_DEFAULT)) {
    errors.push(
      'PGOS_PROVISION_TOKEN must not equal the sandbox dev default (SEC-02)',
    );
  }
  if (isDefaultSecret(prov, INSECURE_PROVISION_DEFAULT)) {
    errors.push(
      'PGOS_PROVISION_TOKEN must be changed from the dev-provision-token default (SEC-02)',
    );
  }
  if (sandbox && prov === sandbox) {
    errors.push(
      'PGOS_PROVISION_TOKEN must differ from SANDBOX_INTERNAL_TOKEN (SEC-02 — decouple provision auth from sandbox)',
    );
  }
  if (prov.length < 16) {
    errors.push('PGOS_PROVISION_TOKEN must be at least 16 characters in production (SEC-02)');
  }
  return errors;
}

/**
 * SEC-01: when either mTLS PEM path is set, both cert and key are required.
 */
export function validateProvisionMtlsProduction(env: {
  PGOS_PROVISION_MTLS_CERT?: string;
  PGOS_PROVISION_MTLS_KEY?: string;
}): string[] {
  const cert = (env.PGOS_PROVISION_MTLS_CERT ?? '').trim();
  const key = (env.PGOS_PROVISION_MTLS_KEY ?? '').trim();
  if (!cert && !key) return [];
  const errors: string[] = [];
  if (!cert || !key) {
    errors.push(
      'PGOS_PROVISION_MTLS_CERT and PGOS_PROVISION_MTLS_KEY must both be set for client mTLS (SEC-01)',
    );
  }
  return errors;
}

/**
 * Fail fast when production is misconfigured (secrets, GitHub, S3, crypto).
 * BOOTSTRAP_ADMIN_PASSWORD is required only when no admin user exists yet.
 */
export function validateProductionEnv(
  env: Env,
  opts?: { adminExists?: boolean },
): void {
  if (env.NODE_ENV !== 'production') return;

  const errors: string[] = [];

  if (!hasRs256Keys(env)) {
    errors.push(
      'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY (or *_PATH) are required in production — HS256 fallback is disabled',
    );
  }

  if (
    isDefaultSecret(env.JWE_SECRET, INSECURE_JWE_DEFAULT) ||
    env.JWE_SECRET.length < 32
  ) {
    errors.push('JWE_SECRET must be a strong random value (≥32 chars), not the default');
  }

  if (isDefaultSecret(env.SANDBOX_INTERNAL_TOKEN, INSECURE_SANDBOX_DEFAULT)) {
    errors.push('SANDBOX_INTERNAL_TOKEN must be changed from the dev default');
  }

  errors.push(
    ...validateProvisionTokenProduction(env.PGOS_PROVISION_TOKEN, env.SANDBOX_INTERNAL_TOKEN),
  );
  errors.push(...validateProvisionMtlsProduction(env));

  if (env.GITHUB_MOCK) {
    errors.push('GITHUB_MOCK must be false in production');
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    errors.push(
      'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are required',
    );
  }

  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
    errors.push('GITHUB_OWNER and GITHUB_REPO are required');
  }

  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    errors.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required in production');
  }

  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL is required in production');
  }

  if (!env.REDIS_URL) {
    errors.push('REDIS_URL is required in production');
  }

  const corsRaw = env.CORS_ALLOWED_ORIGINS.trim();
  if (!corsRaw && !env.PUBLIC_BASE_URL.startsWith('http')) {
    errors.push('CORS_ALLOWED_ORIGINS or a valid PUBLIC_BASE_URL is required in production');
  }

  const needsBootstrap = opts?.adminExists === false;
  if (needsBootstrap && !env.BOOTSTRAP_ADMIN_PASSWORD) {
    errors.push(
      'BOOTSTRAP_ADMIN_PASSWORD is required to seed the first admin (no admin user exists)',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Production environment validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
}