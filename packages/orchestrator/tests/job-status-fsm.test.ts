import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionJobStatus } from '@vibrato/shared';

describe('job status FSM (updateStatus guard)', () => {
  it('allows worker staging pipeline transitions', () => {
    assert.equal(canTransitionJobStatus('STAGING', 'VALIDATING'), true);
    assert.equal(canTransitionJobStatus('VALIDATING', 'VALIDATION_REPORT'), true);
    assert.equal(canTransitionJobStatus('VALIDATION_REPORT', 'COMMITTING'), true);
    assert.equal(canTransitionJobStatus('COMMITTING', 'POST_COMMIT_VERIFY'), true);
    assert.equal(canTransitionJobStatus('POST_COMMIT_VERIFY', 'COMPLETED'), true);
  });

  it('blocks invalid skip-ahead transitions', () => {
    assert.equal(canTransitionJobStatus('QUEUED', 'COMPLETED'), false);
    assert.equal(canTransitionJobStatus('STAGING', 'COMPLETED'), false);
  });

  it('allows reclaim redispatch from LOCK_STALE', () => {
    assert.equal(canTransitionJobStatus('LOCK_STALE', 'QUEUED'), true);
  });
});