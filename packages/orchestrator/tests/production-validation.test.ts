import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProductionEnv,
  validateProvisionTokenProduction,
  validateProvisionMtlsProduction,
  validateServiceTokenProduction,
  isMergeOutboxEnabled,
} from '../src/config/production-validation.js';
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
    GITHUB_MOCK_DISPATCH_FAIL: false,
    GITHUB_MOCK_RUN_CONCLUSION: 'success',
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
    PGOS_AGENT_TOKEN: 'prod-agent-token-for-fencing-validate!!',
    AGENT_ROTATE_URL: '',
    PGOS_SERVICE_TOKEN: 'prod-service-token-merge-outbox!!',
    PGOS_PROVISION_TOKEN: 'prod-provision-token-dedicated-sec02!!',
    PGOS_PROVISION_MTLS_CERT: '',
    PGOS_PROVISION_MTLS_KEY: '',
    PGOS_PROVISION_MTLS_CA: '',
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

  // ── SEC-02 ──────────────────────────────────────────────────────────
  it('SEC-02: fails when provision token equals sandbox dev default', () => {
    assert.throws(
      () =>
        validateProductionEnv(
          baseEnv({ PGOS_PROVISION_TOKEN: 'dev-sandbox-token' }),
          { adminExists: true },
        ),
      /PGOS_PROVISION_TOKEN|SEC-02|sandbox/,
    );
  });

  it('SEC-02: fails when provision token is empty in production', () => {
    assert.throws(
      () =>
        validateProductionEnv(baseEnv({ PGOS_PROVISION_TOKEN: '' }), { adminExists: true }),
      /PGOS_PROVISION_TOKEN/,
    );
  });

  it('SEC-02: fails when provision token equals SANDBOX_INTERNAL_TOKEN', () => {
    const shared = 'shared-token-must-not-couple-sec02!!';
    assert.throws(
      () =>
        validateProductionEnv(
          baseEnv({
            SANDBOX_INTERNAL_TOKEN: shared,
            PGOS_PROVISION_TOKEN: shared,
          }),
          { adminExists: true },
        ),
      /differ from SANDBOX_INTERNAL_TOKEN|SEC-02/,
    );
  });

  it('SEC-02: fails when provision token is the dev-provision-token default', () => {
    const errs = validateProvisionTokenProduction(
      'dev-provision-token',
      'prod-sandbox-token-32chars-minimum!!',
    );
    assert.ok(errs.some((e) => e.includes('dev-provision-token')));
  });

  it('SEC-02: validateProvisionTokenProduction accepts dedicated strong token', () => {
    assert.deepEqual(
      validateProvisionTokenProduction(
        'prod-provision-token-dedicated-sec02!!',
        'prod-sandbox-token-32chars-minimum!!',
      ),
      [],
    );
  });

  // ── SEC-01 ──────────────────────────────────────────────────────────
  it('SEC-01: fails when only MTLS cert path is set', () => {
    assert.throws(
      () =>
        validateProductionEnv(
          baseEnv({ PGOS_PROVISION_MTLS_CERT: '/etc/pgos/client.crt' }),
          { adminExists: true },
        ),
      /MTLS|SEC-01/,
    );
  });

  it('SEC-01: validateProvisionMtlsProduction requires both or neither', () => {
    assert.equal(validateProvisionMtlsProduction({}).length, 0);
    assert.ok(
      validateProvisionMtlsProduction({
        PGOS_PROVISION_MTLS_CERT: '/c.pem',
      }).length > 0,
    );
    assert.equal(
      validateProvisionMtlsProduction({
        PGOS_PROVISION_MTLS_CERT: '/c.pem',
        PGOS_PROVISION_MTLS_KEY: '/k.pem',
      }).length,
      0,
    );
  });

  // ── ENV-02 PGOS_SERVICE_TOKEN ──────────────────────────────────────
  it('ENV-02: fails when PGOS_SERVICE_TOKEN empty and merge outbox enabled', () => {
    assert.throws(
      () =>
        validateProductionEnv(baseEnv({ PGOS_SERVICE_TOKEN: '' }), {
          adminExists: true,
          processEnv: {},
        }),
      /PGOS_SERVICE_TOKEN|ENV-02/,
    );
  });

  it('ENV-02: allows empty service token when structural merge disabled', () => {
    assert.doesNotThrow(() =>
      validateProductionEnv(baseEnv({ PGOS_SERVICE_TOKEN: '' }), {
        adminExists: true,
        processEnv: { PGOS_STRUCTURAL_MERGE: '0' },
      }),
    );
  });

  it('ENV-02: fails when PGOS_SERVICE_TOKEN shorter than 16 chars', () => {
    const errs = validateServiceTokenProduction('short', true);
    assert.ok(errs.some((e) => e.includes('16 characters')));
  });

  it('ENV-02: validateServiceTokenProduction accepts dedicated token', () => {
    assert.deepEqual(
      validateServiceTokenProduction('prod-service-token-merge-outbox!!', true),
      [],
    );
  });

  it('ENV-02: isMergeOutboxEnabled respects PGOS_STRUCTURAL_MERGE', () => {
    assert.equal(isMergeOutboxEnabled({}), true);
    assert.equal(isMergeOutboxEnabled({ PGOS_STRUCTURAL_MERGE: '0' }), false);
    assert.equal(isMergeOutboxEnabled({ PGOS_STRUCTURAL_MERGE: 'false' }), false);
    assert.equal(isMergeOutboxEnabled({ PGOS_STRUCTURAL_MERGE: '1' }), true);
  });

  // ── ENV-01 PGOS_AGENT_TOKEN warn (non-fatal) ───────────────────────
  it('ENV-01: empty PGOS_AGENT_TOKEN does not fail production validation', () => {
    assert.doesNotThrow(() =>
      validateProductionEnv(baseEnv({ PGOS_AGENT_TOKEN: '' }), {
        adminExists: true,
        processEnv: {},
      }),
    );
  });
});