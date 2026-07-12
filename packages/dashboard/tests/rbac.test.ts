import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccess,
  canCreateProject,
  canEnqueueJob,
} from '../src/lib/rbac.js';

describe('dashboard RBAC (H-07)', () => {
  it('viewer cannot access extensions or dead-letter', () => {
    assert.equal(canAccess('viewer', '/extensions'), false);
    assert.equal(canAccess('viewer', '/dead-letter'), false);
    assert.equal(canAccess('viewer', '/jobs'), true);
    assert.equal(canAccess('viewer', '/projects'), true);
  });

  it('operator can dead-letter but not extensions', () => {
    assert.equal(canAccess('operator', '/dead-letter'), true);
    assert.equal(canAccess('operator', '/extensions'), false);
    assert.equal(canEnqueueJob('operator'), true);
    assert.equal(canCreateProject('operator'), false);
  });

  it('admin can access extensions, audit logs, and create projects', () => {
    assert.equal(canAccess('admin', '/extensions'), true);
    assert.equal(canAccess('admin', '/audit'), true);
    assert.equal(canAccess('admin', '/dead-letter'), true);
    assert.equal(canCreateProject('admin'), true);
  });

  it('viewer cannot access audit logs', () => {
    assert.equal(canAccess('viewer', '/audit'), false);
    assert.equal(canAccess('operator', '/audit'), false);
  });
});
