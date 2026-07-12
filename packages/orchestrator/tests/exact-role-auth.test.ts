import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasExactRole, hasMinRole } from '@vibrato/shared';

describe('exact role authorization', () => {
  it('hasExactRole rejects operator for callback-only endpoints', () => {
    assert.equal(hasExactRole('callback', 'callback'), true);
    assert.equal(hasExactRole('operator', 'callback'), false);
    assert.equal(hasExactRole('admin', 'callback'), false);
  });

  it('hasMinRole still allows operator for callback minimum (contrast)', () => {
    assert.equal(hasMinRole('operator', 'callback'), true);
  });
});