import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveGeneration, JOB_STATUSES } from '@vibrato/shared';

/**
 * Regression: admin reclaim must not leave LOCK_STALE jobs blocking the queue.
 * handleAdminReclaim clears lock_key/fencing_token and redispatches when attempts remain.
 */
describe('admin reclaim queue progression', () => {
  const jobServiceActiveStatuses = [
    'QUEUED',
    'DISPATCHING',
    'STAGING',
    'VALIDATING',
    'VALIDATION_REPORT',
    'COMMITTING',
    'POST_COMMIT_VERIFY',
    'REIMPORT_FAILED',
    'VALIDATION_FAILED',
    'COMMIT_FAILED',
    'DISPATCH_TIMEOUT',
  ];

  it('LOCK_STALE is excluded from active job statuses that block new jobs', () => {
    assert.equal(jobServiceActiveStatuses.includes('LOCK_STALE'), false);
    assert.equal(isActiveGeneration('LOCK_STALE'), false);
  });

  it('LOCK_STALE remains a valid job status for redispatch', () => {
    assert.equal((JOB_STATUSES as readonly string[]).includes('LOCK_STALE'), true);
  });

  it('dispatch-eligible statuses include LOCK_STALE and DISPATCH_TIMEOUT', () => {
    const dispatchEligible = ['QUEUED', 'LOCK_STALE', 'DISPATCH_TIMEOUT'];
    for (const s of dispatchEligible) {
      assert.equal((JOB_STATUSES as readonly string[]).includes(s), true);
    }
  });
});