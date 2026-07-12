import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionEnv } from '../src/config/production-validation.js';
import type { Env } from '../src/config/env.js';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    PORT: 8080,
    HOST: '0.0.0.0',
    PUBLIC_BASE_URL: 'https://pgos.example.com',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://pgos:pgos@localhost:5432/pgos',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: '',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'pgos-artifacts',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_FORCE_PATH_STYLE: false,
    JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
    JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
    JWT_ISSUER: 'pgos',
    JWT_AUDIENCE: 'pgos-api',
    SESSION_TTL_SECONDS: 86400,
    GITHUB_APP_ID: '1',
    GITHUB_APP_INSTALLATION_ID: '2',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GITHUB_OWNER: 'org',
    GITHUB_REPO: 'repo',
    GITHUB_WORKFLOW_FILE: 'godot_worker.yml',
    GITHUB_DEFAULT_REF: 'main',
    GITHUB_MOCK: false,
    DISPATCH_TIMEOUT_MS: 60_000,
    DISPATCH_POLL_INTERVAL_MS: 5_000,
    DISPATCH_MAX_CONSECUTIVE_FAILURES: 3,
    HEARTBEAT_INTERVAL_MS: 15_000,
    HEARTBEAT_STALE_AFTER_MS: 30_000,
    TIER_A_QUEUE_THRESHOLD: 3,
    CALLBACK_TOKEN_TTL_MS: 300_000,
    GODOT_DEFAULT_VERSION: '4.3.1',
    REIMPORT_TIMEOUT_MS: 300_000,
    REIMPORT_MAX_RETRIES: 2,
    SLACK_WEBHOOK_URL: '',
    ALERT_WEBHOOK_URL: '',
    SMTP_URL: '',
    ADMIN_EMAIL: '',
    SANDBOX_SERVICE_URL: 'http://localhost:8090',
    SANDBOX_INTERNAL_TOKEN: 'prod-sandbox-token-32chars-minimum!!',
    JWE_SECRET: 'prod-jwe-secret-32chars-minimum-value!!',
    RATE_LIMIT_PER_MINUTE: 120,
    RATE_LIMIT_BURST: 30,
    ORCHESTRATOR_CACHE_DIR: './.cache/pgos',
    TIER_A_ENABLED: true,
    TIER_B_ENABLED: true,
    CORS_ALLOWED_ORIGINS: '',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    ...overrides,
  };
}

describe('production env validation', () => {
  it('accepts a fully configured production env when admin exists', () => {
    assert.doesNotThrow(() => validateProductionEnv(baseEnv(), { adminExists: true }));
  });

  it('requires bootstrap password when no admin exists', () => {
    assert.throws(
      () => validateProductionEnv(baseEnv({ BOOTSTRAP_ADMIN_PASSWORD: '' }), { adminExists: false }),
      /BOOTSTRAP_ADMIN_PASSWORD/,
    );
  });

  it('rejects default secrets in production', () => {
    assert.throws(
      () => validateProductionEnv(baseEnv({ JWE_SECRET: 'change-me-to-a-32-byte-or-longer-secret!!' }), { adminExists: true }),
      /JWE_SECRET/,
    );
  });

  it('skips validation in development', () => {
    assert.doesNotThrow(() =>
      validateProductionEnv(baseEnv({ NODE_ENV: 'development', JWE_SECRET: 'change-me' }), { adminExists: false }),
    );
  });
});