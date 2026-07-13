import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProductionEnv } from './production-validation.js';

// Load .env from monorepo root when present
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, '../../../../.env') });
loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().default('postgresql://pgos:pgos@localhost:5432/pgos'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('pgos-artifacts'),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PRIVATE_KEY_PATH: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().optional(),
  JWT_ISSUER: z.string().default('pgos'),
  JWT_AUDIENCE: z.string().default('pgos-api'),
  SESSION_TTL_SECONDS: z.coerce.number().default(86400),

  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_APP_INSTALLATION_ID: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_OWNER: z.string().optional().default(''),
  GITHUB_REPO: z.string().optional().default(''),
  GITHUB_WORKFLOW_FILE: z.string().default('godot_worker.yml'),
  GITHUB_DEFAULT_REF: z.string().default('main'),
  /**
   * When true, skip real GitHub API and simulate dispatch.
   * Defaults: true in development/test, false in production.
   * Explicit GITHUB_MOCK=true|false always wins.
   */
  GITHUB_MOCK: z
    .string()
    .optional()
    .transform((v) => {
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return process.env.NODE_ENV !== 'production';
    }),
  /**
   * M-18: When true **and** GITHUB_MOCK, dispatchWorkflow throws so local E2E
   * can exercise DISPATCH_FAILED handling without a real GitHub App.
   */
  GITHUB_MOCK_DISPATCH_FAIL: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  /**
   * M-18: Mock getRunStatus conclusion when GITHUB_MOCK is true.
   * success | failure | cancelled | timed_out | action_required | neutral | skipped
   */
  GITHUB_MOCK_RUN_CONCLUSION: z
    .enum([
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'neutral',
      'skipped',
    ])
    .optional()
    .default('success'),

  DISPATCH_TIMEOUT_MS: z.coerce.number().default(60_000),
  DISPATCH_POLL_INTERVAL_MS: z.coerce.number().default(5_000),
  DISPATCH_MAX_CONSECUTIVE_FAILURES: z.coerce.number().default(3),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(15_000),
  HEARTBEAT_STALE_AFTER_MS: z.coerce.number().default(30_000),
  TIER_A_QUEUE_THRESHOLD: z.coerce.number().default(3),
  CALLBACK_TOKEN_TTL_MS: z.coerce.number().default(300_000),
  GODOT_DEFAULT_VERSION: z.string().default('4.3.1'),
  /**
   * L-05: Embedded in dispatch JWE as reimportTimeoutSec for workers
   * (run-generation / post-commit-verify REIMPORT_TIMEOUT_SEC).
   */
  REIMPORT_TIMEOUT_MS: z.coerce.number().default(300_000),
  /**
   * L-05: Embedded in dispatch JWE as reimportMaxRetries for workers
   * (REIMPORT_MAX_RETRIES).
   */
  REIMPORT_MAX_RETRIES: z.coerce.number().default(2),

  SLACK_WEBHOOK_URL: z.string().optional().default(''),
  ALERT_WEBHOOK_URL: z.string().optional().default(''),
  SMTP_URL: z.string().optional().default(''),
  ADMIN_EMAIL: z.string().optional().default(''),

  SANDBOX_SERVICE_URL: z.string().default('http://localhost:8090'),
  SANDBOX_INTERNAL_TOKEN: z.string().default('dev-sandbox-token'),

  /**
   * ENV-01: Bearer token commit-agents use for POST /locks/validate-token.
   * Cross-ref packages/commit-agent README (`PGOS_AGENT_TOKEN` / -auth-token).
   */
  PGOS_AGENT_TOKEN: z.string().optional().default(''),

  /**
   * ENV-01: Optional URL health-worker secret-rotation cron calls for target key rotation.
   */
  AGENT_ROTATE_URL: z.string().optional().default(''),

  /**
   * ENV-02 / H-02: Service token for merge-outbox complete callback
   * (`POST /api/v1/merge-outbox/:id/complete`) and sealed into merge_apply JWE.
   * Also used by merge_apply.yml as PGOS_SERVICE_TOKEN Actions secret fallback.
   */
  PGOS_SERVICE_TOKEN: z.string().optional().default(''),

  /**
   * SEC-02 / DEP-01: Bearer for target JIT SSH provisioner (`POST …/v1/provision`).
   * Prefer this over SANDBOX_INTERNAL_TOKEN. Empty → orchestrator falls back to
   * SANDBOX_INTERNAL_TOKEN with a deprecation warning (dev only; required in prod).
   */
  PGOS_PROVISION_TOKEN: z.string().optional().default(''),

  /**
   * SEC-01: optional client mTLS PEM paths for provision HTTP client.
   * When either is set, both CERT and KEY are required (production-validation).
   */
  PGOS_PROVISION_MTLS_CERT: z.string().optional().default(''),
  PGOS_PROVISION_MTLS_KEY: z.string().optional().default(''),
  /** Optional CA PEM path to trust target provisioner server cert (SEC-01). */
  PGOS_PROVISION_MTLS_CA: z.string().optional().default(''),

  JWE_SECRET: z.string().default('change-me-to-a-32-byte-or-longer-secret!!'),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(120),
  RATE_LIMIT_BURST: z.coerce.number().default(30),

  /** Local cache dir for orchestrator only — never used for worker artifacts. */
  ORCHESTRATOR_CACHE_DIR: z.string().default('./.cache/pgos'),

  TIER_A_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  TIER_B_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),

  /** Comma-separated CORS origins; production defaults to PUBLIC_BASE_URL only. */
  CORS_ALLOWED_ORIGINS: z.string().optional().default(''),

  /** One-time bootstrap admin password (required in production when no admin exists). */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().default('admin@localhost'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten());
    throw new Error('Invalid environment configuration');
  }
  cached = parsed.data;
  // Bootstrap password checked after DB probe in index.ts
  validateProductionEnv(cached, { adminExists: true });
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
