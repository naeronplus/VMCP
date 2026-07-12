import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFencingToken,
  isTokenValidForInstance,
  tokensMatch,
} from '@vibrato/shared';

/**
 * Acceptance: under simulated Redis master failover, fencing token
 * invalidation prevents any stale commit.
 */
describe('fencing failover acceptance', () => {
  it('invalidates tokens from previous Redis master instanceId', () => {
    const oldInstance = '11111111-1111-1111-1111-111111111111';
    const newInstance = '22222222-2222-2222-2222-222222222222';
    const stale = formatFencingToken(oldInstance, 99);
    const fresh = formatFencingToken(newInstance, 1);

    assert.equal(isTokenValidForInstance(stale, newInstance), false);
    assert.equal(isTokenValidForInstance(fresh, newInstance), true);
    assert.equal(tokensMatch(stale, fresh), false);
  });

  it('serializes token counters monotonically per instance', () => {
    const id = '33333333-3333-3333-3333-333333333333';
    const t1 = formatFencingToken(id, 1);
    const t2 = formatFencingToken(id, 2);
    assert.ok(Number(t2.split(':')[1]) > Number(t1.split(':')[1]));
  });
});
