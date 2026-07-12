/**
 * H-03: remote UID reconcile auto-dispatch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canAutoDispatchUidReconcile,
  dispatchUidReconcile,
  type UidRemoteDispatchDeps,
} from '../src/services/uid-remote-dispatch.js';
import { reconcileProjectFiles } from '../src/services/uid-file-reconcile.js';

describe('uid remote dispatch (H-03)', () => {
  it('canAutoDispatchUidReconcile requires host or provision URL', () => {
    assert.equal(canAutoDispatchUidReconcile({}), false);
    assert.equal(canAutoDispatchUidReconcile({ targetHost: 'u@h' }), true);
    assert.equal(
      canAutoDispatchUidReconcile({ targetProvisionUrl: 'http://x/v1/provision' }),
      true,
    );
    assert.equal(
      canAutoDispatchUidReconcile({ uidReconcileUrl: 'http://x/uid' }),
      true,
    );
  });

  it('dispatchUidReconcile uploads map and dispatches workflow', async () => {
    const puts: { key: string; body: string }[] = [];
    const dispatches: { id: string; inputs: Record<string, string> }[] = [];
    const audits: unknown[] = [];
    const deps: UidRemoteDispatchDeps = {
      async putObject(key, body) {
        puts.push({ key, body });
      },
      async presignGet(key) {
        return `https://s3.test/${key}`;
      },
      async dispatchWorkflowFile(id, inputs) {
        dispatches.push({ id, inputs });
        return { dispatched: true, mock: true, mockRunId: 42 };
      },
      async audit(input) {
        audits.push(input);
      },
      async sendAlert() {},
    };

    const result = await dispatchUidReconcile({
      projectId: 'p1',
      projectRoot: '/var/godot/projects/p1',
      replacements: new Map([['uid://OLD', 'uid://NEW']]),
      metadata: { targetHost: 'user@target', targetProvisionUrl: 'http://t/v1' },
      deps,
    });

    assert.equal(result.mode, 'remote_dispatched');
    assert.equal(puts.length, 1);
    assert.match(puts[0]!.body, /uid:\/\/OLD/);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.id, 'uid_reconcile.yml');
    assert.equal(dispatches[0]!.inputs.projectId, 'p1');
    assert.ok(dispatches[0]!.inputs.replacementsGetUrl.startsWith('https://s3.test/'));
    assert.equal(result.mode === 'remote_dispatched' && result.workflowRunId, 42);
    assert.ok(
      audits.some(
        (a) =>
          (a as { detail?: { mode?: string } }).detail?.mode === 'remote_dispatched',
      ),
    );
  });

  it('dispatch without metadata falls back to remote_script', async () => {
    const deps: UidRemoteDispatchDeps = {
      async putObject() {
        throw new Error('should not put');
      },
      async presignGet() {
        return '';
      },
      async dispatchWorkflowFile() {
        throw new Error('should not dispatch');
      },
      async audit() {},
      async sendAlert() {},
    };
    const result = await dispatchUidReconcile({
      projectId: 'p1',
      projectRoot: '/remote/p',
      replacements: { 'uid://a': 'uid://b' },
      metadata: {},
      deps,
    });
    assert.equal(result.mode, 'remote_script');
  });

  it('dispatch failure alerts E008 and returns remote_script', async () => {
    const alerts: { code?: string }[] = [];
    const deps: UidRemoteDispatchDeps = {
      async putObject() {},
      async presignGet() {
        return 'https://s3/x';
      },
      async dispatchWorkflowFile() {
        throw new Error('github down');
      },
      async audit() {},
      async sendAlert(a) {
        alerts.push(a);
      },
    };
    const result = await dispatchUidReconcile({
      projectId: 'p1',
      projectRoot: '/remote/p',
      replacements: new Map([['uid://a', 'uid://b']]),
      metadata: { targetHost: 'h' },
      deps,
    });
    assert.equal(result.mode, 'remote_script');
    assert.match(result.detail, /github down/);
    assert.equal(alerts[0]?.code, 'E008');
  });

  it('reconcileProjectFiles unreadable root with metadata → remote_dispatched', async () => {
    const missing = path.join(os.tmpdir(), `pgos-uid-missing-${Date.now()}`);
    // ensure absent
    try {
      fs.rmSync(missing, { recursive: true, force: true });
    } catch {
      /* ok */
    }

    let called = false;
    const result = await reconcileProjectFiles({
      projectId: 'p-remote',
      projectRoot: missing,
      replacements: new Map([['uid://x', 'uid://y']]),
      metadata: { targetHost: 'user@h' },
      dispatchRemote: async () => {
        called = true;
        return { mode: 'remote_dispatched', s3Key: 'projects/p/uid.json' };
      },
    });
    assert.equal(called, true);
    assert.equal(result.mode, 'remote_dispatched');
    assert.equal(result.s3Key, 'projects/p/uid.json');
  });
});
