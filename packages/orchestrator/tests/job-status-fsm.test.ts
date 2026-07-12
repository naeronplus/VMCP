import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionJobStatus,
  ERROR_CATALOG,
  type JobStatus,
} from '@vibrato/shared';

/**
 * Mirrors JobService.updateStatus invalid-transition error construction (M-02).
 * Kept local so we pin E021 without spinning up Postgres for every FSM edge.
 */
function invalidTransitionError(from: JobStatus, to: JobStatus) {
  return Object.assign(
    new Error(`Invalid status transition ${from} → ${to}`),
    {
      statusCode: ERROR_CATALOG.E021.httpStatus,
      code: 'E021' as const,
    },
  );
}

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

  it('M-02: invalid FSM transition maps to E021 (409), not E019', () => {
    assert.equal(canTransitionJobStatus('QUEUED', 'COMPLETED'), false);
    const err = invalidTransitionError('QUEUED', 'COMPLETED');
    assert.equal(err.code, 'E021');
    assert.equal(err.statusCode, 409);
    assert.equal(err.statusCode, ERROR_CATALOG.E021.httpStatus);
    assert.notEqual(err.code, 'E019');
    assert.equal(ERROR_CATALOG.E019.class, 'SCRIPT_OVERRIDE_REQUIRES_ADMIN');
    assert.equal(ERROR_CATALOG.E021.class, 'INVALID_STATUS_TRANSITION');
  });

  it('M-02: REIMPORT_FAILED cannot go to COMMITTING/COMPLETED (E021 class)', () => {
    assert.equal(canTransitionJobStatus('REIMPORT_FAILED', 'COMMITTING'), false);
    assert.equal(canTransitionJobStatus('REIMPORT_FAILED', 'COMPLETED'), false);
    assert.equal(canTransitionJobStatus('REIMPORT_FAILED', 'QUEUED'), true);
    const err = invalidTransitionError('REIMPORT_FAILED', 'COMMITTING');
    assert.equal(err.code, 'E021');
    assert.equal(err.statusCode, 409);
  });

  it('job-service source uses E021 for invalid transitions (regression guard)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/job-service.ts'), 'utf8');
    // Invalid transition branch must reference E021, not E019
    assert.match(src, /Invalid status transition[\s\S]{0,200}code:\s*['"]E021['"]/);
    assert.doesNotMatch(
      src,
      /Invalid status transition[\s\S]{0,200}code:\s*['"]E019['"]/,
    );
  });
});
