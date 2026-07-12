import type { Env } from './env.js';

const INSECURE_JWE_DEFAULT = 'change-me-to-a-32-byte-or-longer-secret!!';
const INSECURE_SANDBOX_DEFAULT = 'dev-sandbox-token';

function hasRs256Keys(env: Env): boolean {
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) return true;
  if (env.JWT_PRIVATE_KEY_PATH && env.JWT_PUBLIC_KEY_PATH) return true;
  return false;
}

function isDefaultSecret(value: string, defaultValue: string): boolean {
  return value === defaultValue;
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