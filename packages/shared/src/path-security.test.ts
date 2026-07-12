import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertArtifactKey,
  assertArtifactKeyForJob,
  assertWithinBase,
  isSafeLogicalAssetPath,
  PathTraversalError,
} from './path-security.js';
import path from 'node:path';

describe('path security', () => {
  it('allows paths within base', () => {
    const base = path.resolve('/projects/game');
    const result = assertWithinBase(base, 'scenes/main.tscn');
    assert.ok(result.includes('main.tscn'));
  });

  it('blocks traversal', () => {
    const base = path.resolve('/projects/game');
    assert.throws(
      () => assertWithinBase(base, '../../etc/passwd'),
      PathTraversalError,
    );
  });

  it('validates logical asset paths', () => {
    assert.equal(isSafeLogicalAssetPath('scenes/player.tscn'), true);
    assert.equal(isSafeLogicalAssetPath('../escape'), false);
    assert.equal(isSafeLogicalAssetPath('/abs'), false);
  });

  it('validates S3 artifact key prefixes', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const jobId = '22222222-2222-4222-8222-222222222222';
    const key = `projects/${projectId}/jobs/${jobId}/staging/data.tar.gz`;
    assert.equal(assertArtifactKey(key), key);
    assert.equal(assertArtifactKeyForJob(key, projectId, jobId), key);
    assert.throws(() => assertArtifactKey('etc/passwd'), PathTraversalError);
    assert.throws(
      () => assertArtifactKeyForJob(key, projectId, '33333333-3333-4333-8333-333333333333'),
      PathTraversalError,
    );
  });
});
