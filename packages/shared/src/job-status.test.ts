import { describe, it } from 'node:test';
import { hasExactRole } from './job-status.js';
import assert from 'node:assert/strict';
import {
  canTransitionJobStatus,
  isTerminal,
  isRetriableFailure,
  isActiveGeneration,
} from './job-status.js';

describe('job status classification', () => {
  it('treats retriable failures as non-terminal (lock must stay held)', () => {
    for (const s of [
      'REIMPORT_FAILED',
      'VALIDATION_FAILED',
      'COMMIT_FAILED',
      'DISPATCH_TIMEOUT',
    ] as const) {
      assert.equal(isRetriableFailure(s), true);
      assert.equal(isTerminal(s), false);
    }
  });

  it('treats final outcomes as terminal', () => {
    for (const s of [
      'COMPLETED',
      'ROLLBACK',
      'DEP_FAILED',
      'CANCELLED',
      'DEAD_LETTER',
    ] as const) {
      assert.equal(isTerminal(s), true);
      assert.equal(isRetriableFailure(s), false);
    }
  });

  it('classifies active generation statuses', () => {
    assert.equal(isActiveGeneration('STAGING'), true);
    assert.equal(isActiveGeneration('COMPLETED'), false);
  });

  it('LOCK_STALE does not block new job creation (not active generation)', () => {
    assert.equal(isActiveGeneration('LOCK_STALE'), false);
    assert.equal(isTerminal('LOCK_STALE'), false);
    assert.equal(isRetriableFailure('LOCK_STALE'), false);
  });

  it('hasExactRole is stricter than minimum rank for callback', () => {
    assert.equal(hasExactRole('operator', 'callback'), false);
    assert.equal(hasExactRole('callback', 'callback'), true);
  });

  it('enforces job status FSM transitions', () => {
    assert.equal(canTransitionJobStatus('QUEUED', 'DISPATCHING'), true);
    assert.equal(canTransitionJobStatus('STAGING', 'COMMITTING'), false);
    assert.equal(canTransitionJobStatus('LOCK_STALE', 'QUEUED'), true);
    assert.equal(canTransitionJobStatus('COMPLETED', 'QUEUED'), false);
  });
});
