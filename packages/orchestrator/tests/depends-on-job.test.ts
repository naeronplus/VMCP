import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canPromoteBlockedJob,
  evaluateDependencyGate,
} from '../src/services/dependency-gate.js';

describe('dependsOnJobId gates (H-01)', () => {
  it('blocks create/dispatch when dependency is still running', () => {
    const g = evaluateDependencyGate(
      { id: 'a', projectId: 'p1', status: 'STAGING' },
      'p1',
    );
    assert.equal(g.action, 'block_dependency');
  });

  it('allows when dependency COMPLETED', () => {
    const g = evaluateDependencyGate(
      { id: 'a', projectId: 'p1', status: 'COMPLETED' },
      'p1',
    );
    assert.equal(g.action, 'allow');
  });

  it('marks DEP_FAILED when dependency terminal non-COMPLETED', () => {
    const g = evaluateDependencyGate(
      { id: 'a', projectId: 'p1', status: 'DEAD_LETTER' },
      'p1',
    );
    assert.equal(g.action, 'dep_failed');
  });

  it('rejects cross-project dependency', () => {
    const g = evaluateDependencyGate(
      { id: 'a', projectId: 'other', status: 'COMPLETED' },
      'p1',
    );
    assert.equal(g.action, 'dep_failed');
  });

  it('does not promote when concurrency clears but dependency incomplete', () => {
    const d = canPromoteBlockedJob({
      dependsOnJobId: 'dep-a',
      blockedByJobId: 'fin',
      finishedJobId: 'fin',
      finishedStatus: 'COMPLETED',
      dependencyStatus: 'STAGING',
      concurrentActiveHeld: false,
      blockedByStatus: 'COMPLETED',
    });
    assert.equal(d.promote, false);
    assert.equal(d.depFailed, undefined);
  });

  it('DEP_FAILED when dependency finishes non-COMPLETED', () => {
    const d = canPromoteBlockedJob({
      dependsOnJobId: 'dep-a',
      blockedByJobId: 'dep-a',
      finishedJobId: 'dep-a',
      finishedStatus: 'ROLLBACK',
      dependencyStatus: 'ROLLBACK',
      concurrentActiveHeld: false,
      blockedByStatus: 'ROLLBACK',
    });
    assert.equal(d.depFailed, true);
    assert.equal(d.promote, false);
  });

  it('promotes when dependency COMPLETED and no concurrent holder', () => {
    const d = canPromoteBlockedJob({
      dependsOnJobId: 'dep-a',
      blockedByJobId: 'dep-a',
      finishedJobId: 'dep-a',
      finishedStatus: 'COMPLETED',
      dependencyStatus: 'COMPLETED',
      concurrentActiveHeld: false,
      blockedByStatus: 'COMPLETED',
    });
    assert.equal(d.promote, true);
  });

  it('skips promote while another concurrent job still active', () => {
    const d = canPromoteBlockedJob({
      dependsOnJobId: null,
      blockedByJobId: 'other',
      finishedJobId: 'fin',
      finishedStatus: 'COMPLETED',
      dependencyStatus: null,
      concurrentActiveHeld: true,
      blockedByStatus: 'COMMITTING',
    });
    assert.equal(d.promote, false);
  });
});
