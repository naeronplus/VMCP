import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionJobStatus,
  isRetriableFailure,
} from '@vibrato/shared';
import {
  GitHubDispatchError,
  GITHUB_DISPATCH_ERROR_CODE,
  mockGetRunStatusResult,
  shouldSimulateMockDispatchFailure,
} from '../src/services/github-service.js';

/**
 * Mirrors job-service dispatchWorkflow catch → DISPATCH_FAILED (M-18 explicit path).
 */
function statusAfterDispatchError(): 'DISPATCH_FAILED' {
  return 'DISPATCH_FAILED';
}

describe('GitHub mock dispatch failure (M-18)', () => {
  it('shouldSimulateMockDispatchFailure only when both mock flags set', () => {
    assert.equal(
      shouldSimulateMockDispatchFailure({
        GITHUB_MOCK: true,
        GITHUB_MOCK_DISPATCH_FAIL: true,
      }),
      true,
    );
    assert.equal(
      shouldSimulateMockDispatchFailure({
        GITHUB_MOCK: true,
        GITHUB_MOCK_DISPATCH_FAIL: false,
      }),
      false,
    );
    assert.equal(
      shouldSimulateMockDispatchFailure({
        GITHUB_MOCK: false,
        GITHUB_MOCK_DISPATCH_FAIL: true,
      }),
      false,
    );
  });

  it('mockGetRunStatusResult defaults to success and can return failure', () => {
    assert.deepEqual(
      mockGetRunStatusResult({
        GITHUB_MOCK: true,
        GITHUB_MOCK_RUN_CONCLUSION: 'success',
      }),
      { status: 'completed', conclusion: 'success' },
    );
    assert.deepEqual(
      mockGetRunStatusResult({
        GITHUB_MOCK: true,
        GITHUB_MOCK_RUN_CONCLUSION: 'failure',
      }),
      { status: 'completed', conclusion: 'failure' },
    );
    assert.deepEqual(
      mockGetRunStatusResult({
        GITHUB_MOCK: true,
        GITHUB_MOCK_RUN_CONCLUSION: 'cancelled',
      }),
      { status: 'completed', conclusion: 'cancelled' },
    );
  });

  it('GitHubDispatchError has stable code for operators/tests', () => {
    const err = new GitHubDispatchError(
      'GITHUB_MOCK_DISPATCH_FAIL: simulated workflow_dispatch failure',
    );
    assert.equal(err.code, GITHUB_DISPATCH_ERROR_CODE);
    assert.equal(err.name, 'GitHubDispatchError');
    assert.match(err.message, /GITHUB_MOCK_DISPATCH_FAIL/);
  });

  it('dispatch failure maps to DISPATCH_FAILED (retriable) from DISPATCHING', () => {
    const next = statusAfterDispatchError();
    assert.equal(next, 'DISPATCH_FAILED');
    assert.equal(canTransitionJobStatus('DISPATCHING', 'DISPATCH_FAILED'), true);
    assert.equal(isRetriableFailure('DISPATCH_FAILED'), true);
    // Distinct from runner pickup timeout
    assert.equal(canTransitionJobStatus('DISPATCHING', 'DISPATCH_TIMEOUT'), true);
    assert.notEqual(next, 'DISPATCH_TIMEOUT');
  });

  it('github-service source throws on GITHUB_MOCK_DISPATCH_FAIL', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/github-service.ts'), 'utf8');
    assert.match(src, /GITHUB_MOCK_DISPATCH_FAIL/);
    assert.match(src, /shouldSimulateMockDispatchFailure/);
    assert.match(src, /GitHubDispatchError/);
    assert.match(src, /GITHUB_MOCK_RUN_CONCLUSION/);
    assert.match(src, /mockGetRunStatusResult/);
  });

  it('job-service maps dispatch throw to DISPATCH_FAILED not DISPATCH_TIMEOUT', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/job-service.ts'), 'utf8');
    const idx = src.indexOf('await githubService.dispatchWorkflow');
    assert.ok(idx >= 0, 'dispatchWorkflow call missing');
    const window = src.slice(idx, idx + 800);
    assert.match(window, /catch\s*\(/);
    assert.match(window, /status:\s*'DISPATCH_FAILED'/);
    assert.doesNotMatch(window, /status:\s*'DISPATCH_TIMEOUT'/);
    assert.match(window, /GITHUB_MOCK_DISPATCH_FAIL|DISPATCH_FAILED \(retriable\)|workflow_dispatch/);
  });
});

