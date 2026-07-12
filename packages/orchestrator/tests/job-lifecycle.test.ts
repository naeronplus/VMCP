import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetriableFailure,
  isTerminal,
  TERMINAL_STATUSES,
  RETRIABLE_FAILURE_STATUSES,
} from '@vibrato/shared';

/**
 * Regression: retriable failures must never be in TERMINAL_STATUSES.
 * Otherwise updateStatus releases the project lock and promotes blocked jobs
 * while handleFailure requeues — concurrent generation race.
 */
describe('job lifecycle lock/promote invariants', () => {
  it('retriable and terminal sets are disjoint', () => {
    const terminal = new Set(TERMINAL_STATUSES as readonly string[]);
    const retriable = new Set(RETRIABLE_FAILURE_STATUSES as readonly string[]);
    for (const s of retriable) {
      assert.equal(terminal.has(s), false, `${s} must not be terminal`);
      assert.equal(isRetriableFailure(s as never), true);
      assert.equal(isTerminal(s as never), false);
    }
  });

  it('dead-letter is the exhausted-retry sink', () => {
    assert.equal(isTerminal('DEAD_LETTER'), true);
    assert.equal(isRetriableFailure('DEAD_LETTER'), false);
  });
});
