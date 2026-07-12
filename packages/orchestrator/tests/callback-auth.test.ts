import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasMinRole } from '@vibrato/shared';

describe('callback token authorization', () => {
  it('callback role cannot access operator endpoints', () => {
    assert.equal(hasMinRole('callback', 'operator'), false);
    assert.equal(hasMinRole('callback', 'viewer'), false);
    assert.equal(hasMinRole('callback', 'admin'), false);
  });

  it('callback role can access worker-scoped endpoints', () => {
    assert.equal(hasMinRole('callback', 'callback'), true);
    assert.equal(hasMinRole('operator', 'callback'), true);
    assert.equal(hasMinRole('admin', 'callback'), true);
  });

  it('operator retains access to operator endpoints', () => {
    assert.equal(hasMinRole('operator', 'operator'), true);
    assert.equal(hasMinRole('viewer', 'operator'), false);
  });
});