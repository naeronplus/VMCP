/**
 * M-15 / 7.5.1 — validateSandboxProductionEnv matrix + firecrackerHealth.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firecrackerHealth,
  getFirecrackerLauncherMode,
  validateSandboxProductionEnv,
} from '../src/production-validation.js';

const PROD_TOKEN = 'prod-token-not-default';

describe('validateSandboxProductionEnv matrix (M-15 / 7.5.1)', () => {
  it('no-ops when NODE_ENV is not production', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'development',
        FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
        FIRECRACKER_LAUNCHER_MODE: 'stub',
      }),
    );
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'test',
        SANDBOX_INTERNAL_TOKEN: 'dev-sandbox-token',
      }),
    );
    assert.doesNotThrow(() => validateSandboxProductionEnv({}));
  });

  it('production rejects default SANDBOX_INTERNAL_TOKEN', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: 'dev-sandbox-token',
          FIRECRACKER_LAUNCHER_MODE: 'stub',
        }),
      /SANDBOX_INTERNAL_TOKEN must be changed/,
    );
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          // token omitted → default
          FIRECRACKER_LAUNCHER_MODE: 'stub',
        }),
      /SANDBOX_INTERNAL_TOKEN/,
    );
  });

  it('production rejects stub when FIRECRACKER_SOCKET is set (fail-closed)', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
          FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
          FIRECRACKER_LAUNCHER_MODE: 'stub',
        }),
      /stub is not allowed when FIRECRACKER_SOCKET/,
    );
  });

  it('production rejects stub when SANDBOX_BACKEND advertises firecracker', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
          FIRECRACKER_LAUNCHER_MODE: 'stub',
          SANDBOX_BACKEND: 'firecracker',
        }),
      /Production Firecracker path requires FIRECRACKER_LAUNCHER_MODE=real/,
    );
  });

  it('production accepts worker_thread stub without socket', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'production',
        SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
        FIRECRACKER_LAUNCHER_MODE: 'stub',
        SANDBOX_BACKEND: 'worker_thread_policy_enforcer',
      }),
    );
  });

  it('H-08 Path B: production accepts SANDBOX_BACKEND=worker_thread without FIRECRACKER_*', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'production',
        SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
        SANDBOX_BACKEND: 'worker_thread',
        // no FIRECRACKER_SOCKET / MODE
      }),
    );
  });

  it('H-08 Path B: production default backend is worker_thread when unset', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'production',
        SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
      }),
    );
  });

  it('production real mode requires FIRECRACKER_SOCKET', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
          FIRECRACKER_LAUNCHER_MODE: 'real',
          FIRECRACKER_LAUNCHER: '/usr/local/bin/firecracker-launcher.sh',
        }),
      /FIRECRACKER_SOCKET must be set/,
    );
  });

  it('production real mode requires FIRECRACKER_LAUNCHER', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
          FIRECRACKER_LAUNCHER_MODE: 'real',
          FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
        }),
      /FIRECRACKER_LAUNCHER must point/,
    );
  });

  it('production accepts real mode with socket + launcher + non-default token', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'production',
        SANDBOX_INTERNAL_TOKEN: PROD_TOKEN,
        FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
        FIRECRACKER_LAUNCHER: '/usr/local/bin/firecracker-launcher.sh',
        FIRECRACKER_LAUNCHER_MODE: 'real',
      }),
    );
  });

  it('aggregates multiple production errors in one throw', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: 'dev-sandbox-token',
          FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
          FIRECRACKER_LAUNCHER_MODE: 'stub',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /SANDBOX_INTERNAL_TOKEN/);
        assert.match(err.message, /stub is not allowed/);
        return true;
      },
    );
  });
});

describe('firecrackerHealth / launcher mode', () => {
  it('defaults mode to stub', () => {
    assert.equal(getFirecrackerLauncherMode({}), 'stub');
    assert.equal(getFirecrackerLauncherMode({ FIRECRACKER_LAUNCHER_MODE: 'REAL' }), 'real');
    assert.equal(getFirecrackerLauncherMode({ FIRECRACKER_LAUNCHER_MODE: 'other' }), 'stub');
  });

  it('stub never reports firecrackerReady even with socket', () => {
    const h = firecrackerHealth({
      FIRECRACKER_LAUNCHER_MODE: 'stub',
      FIRECRACKER_SOCKET: '/tmp/fc.sock',
      SANDBOX_BACKEND: 'firecracker',
    });
    assert.equal(h.firecrackerReady, false);
    assert.equal(h.backend, 'firecracker-stub');
    assert.equal(h.launcherMode, 'stub');
  });

  it('H-08 Path B: worker_thread reports backend worker_thread and firecrackerReady false', () => {
    const h = firecrackerHealth({
      SANDBOX_BACKEND: 'worker_thread',
      FIRECRACKER_LAUNCHER_MODE: 'stub',
    });
    assert.equal(h.firecrackerReady, false);
    assert.equal(h.backend, 'worker_thread');
    assert.equal(h.policy, 'worker_thread_only');
  });

  it('real mode ready only when socket configured', () => {
    assert.equal(
      firecrackerHealth({ FIRECRACKER_LAUNCHER_MODE: 'real' }).firecrackerReady,
      false,
    );
    assert.equal(
      firecrackerHealth({
        FIRECRACKER_LAUNCHER_MODE: 'real',
        FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
      }).firecrackerReady,
      true,
    );
  });
});
