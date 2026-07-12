import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCrossMachineProvision } from '../src/services/ssh-provision.js';
import {
  canTransitionJobStatus,
  isRetriableFailure,
} from '@vibrato/shared';

describe('cross-machine provision gate (C-06)', () => {
  it('skips provision for same-machine', () => {
    const r = resolveCrossMachineProvision('same-machine', {
      targetHost: 'h',
      targetProvisionUrl: 'http://x',
    });
    assert.equal(r.action, 'not-cross-machine');
  });

  it('fails when host or provision URL missing', () => {
    const a = resolveCrossMachineProvision('cross-machine', { targetHost: 'h' });
    assert.equal(a.action, 'fail');
    const b = resolveCrossMachineProvision('cross-machine', {
      targetProvisionUrl: 'http://p',
    });
    assert.equal(b.action, 'fail');
    const c = resolveCrossMachineProvision('cross-machine', {});
    assert.equal(c.action, 'fail');
  });

  it('requires both host and provision URL for provision action', () => {
    const r = resolveCrossMachineProvision('cross-machine', {
      targetHost: 'user@host',
      targetProvisionUrl: 'https://host/provision',
    });
    assert.equal(r.action, 'provision');
    if (r.action === 'provision') {
      assert.equal(r.targetHost, 'user@host');
      assert.equal(r.provisionUrl, 'https://host/provision');
    }
  });

  it('DISPATCH_FAILED is retriable and reachable from QUEUED', () => {
    assert.equal(isRetriableFailure('DISPATCH_FAILED'), true);
    assert.equal(canTransitionJobStatus('QUEUED', 'DISPATCH_FAILED'), true);
    assert.equal(canTransitionJobStatus('DISPATCH_FAILED', 'QUEUED'), true);
  });
});
