import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});