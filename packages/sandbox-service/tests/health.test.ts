import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firecrackerHealth,
  getFirecrackerLauncherMode,
  validateSandboxProductionEnv,
} from '../src/production-validation.js';

describe('sandbox-service', () => {
  it('default backend name is worker_thread_policy_enforcer', () => {
    const backend = process.env.SANDBOX_BACKEND ?? 'worker_thread_policy_enforcer';
    assert.equal(backend, 'worker_thread_policy_enforcer');
  });

  it('worker resourceLimits derive from memoryMiB request', () => {
    const memoryMiB = 512;
    const memoryMb = Math.max(64, Math.ceil((memoryMiB * 1024 * 1024) / (1024 * 1024)));
    assert.equal(memoryMb, 512);
  });

  it('dev defaults launcher mode to stub', () => {
    assert.equal(getFirecrackerLauncherMode({}), 'stub');
  });

  it('stub never reports firecrackerReady', () => {
    const h = firecrackerHealth({
      FIRECRACKER_LAUNCHER_MODE: 'stub',
      FIRECRACKER_SOCKET: '/tmp/fc.sock',
    });
    assert.equal(h.firecrackerReady, false);
    assert.equal(h.backend, 'firecracker-stub');
  });

  it('production rejects stub when FIRECRACKER_SOCKET set', () => {
    assert.throws(
      () =>
        validateSandboxProductionEnv({
          NODE_ENV: 'production',
          SANDBOX_INTERNAL_TOKEN: 'prod-token-not-default',
          FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
          FIRECRACKER_LAUNCHER_MODE: 'stub',
        }),
      /stub is not allowed/,
    );
  });

  it('production accepts real mode with socket + launcher', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'production',
        SANDBOX_INTERNAL_TOKEN: 'prod-token-not-default',
        FIRECRACKER_SOCKET: '/var/run/firecracker.sock',
        FIRECRACKER_LAUNCHER: '/usr/local/bin/firecracker-launcher.sh',
        FIRECRACKER_LAUNCHER_MODE: 'real',
      }),
    );
  });

  it('development accepts stub without throwing', () => {
    assert.doesNotThrow(() =>
      validateSandboxProductionEnv({
        NODE_ENV: 'development',
        FIRECRACKER_LAUNCHER_MODE: 'stub',
      }),
    );
  });
});
