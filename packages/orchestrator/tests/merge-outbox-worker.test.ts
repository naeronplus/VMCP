/**
 * H-02: merge_outbox consumer — local apply + remote dispatch (mock deps).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRemoteMergeTarget,
  processMergeOutboxRow,
  processPendingMergeOutbox,
  type MergeOutboxDeps,
  type MergeOutboxPendingRow,
} from '../src/workers/merge-outbox-worker.js';
import { applyTscnToFilesystem } from '../src/services/merge-apply.js';

function baseRow(over: Partial<MergeOutboxPendingRow> = {}): MergeOutboxPendingRow {
  return {
    id: 'outbox-1',
    override_id: 'ov-1',
    project_id: 'proj-1',
    path: 'scenes/main.tscn',
    project_root: null,
    patch: {
      nodes: [{ path: 'Root', properties: { position: 'Vector2(1, 2)' } }],
    },
    metadata: {},
    introduces_script: false,
    ...over,
  };
}

function mockDeps(overrides: Partial<MergeOutboxDeps> = {}): MergeOutboxDeps & {
  applied: string[];
  failed: { id: string; detail: string }[];
  dispatched: string[];
  audits: string[];
  dispatches: Record<string, string>[];
} {
  const state = {
    applied: [] as string[],
    failed: [] as { id: string; detail: string }[],
    dispatched: [] as string[],
    audits: [] as string[],
    dispatches: [] as Record<string, string>[],
  };
  const deps: MergeOutboxDeps & typeof state = {
    ...state,
    async listPending() {
      return [];
    },
    async markApplied({ outboxId }) {
      state.applied.push(outboxId);
    },
    async markFailed(outboxId, detail) {
      state.failed.push({ id: outboxId, detail });
    },
    async markDispatched(outboxId) {
      state.dispatched.push(outboxId);
    },
    pathIsReadableDir: async () => false,
    applyTscn: applyTscnToFilesystem,
    async putPatchObject() {},
    async presignGet(key) {
      return `https://s3.example/${key}`;
    },
    async dispatchMergeApply(inputs) {
      state.dispatches.push(inputs);
      return { dispatched: true, mock: true };
    },
    async audit(input) {
      state.audits.push(input.action);
    },
    async sendAlert() {},
    ...overrides,
  };
  return deps;
}

describe('merge-outbox-worker (H-02)', () => {
  it('isRemoteMergeTarget: local readable is not remote', () => {
    assert.equal(isRemoteMergeTarget('/var/godot/p', { targetHost: 'h' }, true), false);
  });

  it('isRemoteMergeTarget: unreadable with targetHost is remote', () => {
    assert.equal(
      isRemoteMergeTarget('/var/godot/p', { targetHost: 'user@host' }, false),
      true,
    );
  });

  it('applies pending local row to filesystem and marks applied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-merge-ob-'));
    const scene = path.join(root, 'scenes', 'main.tscn');
    fs.mkdirSync(path.dirname(scene), { recursive: true });
    fs.writeFileSync(
      scene,
      '[gd_scene format=3]\n[node name="Root" type="Node2D"]\nposition = Vector2(0, 0)\n',
      'utf8',
    );

    const deps = mockDeps({
      pathIsReadableDir: async (d) => d === root,
    });
    const row = baseRow({
      project_root: root,
      path: 'scenes/main.tscn',
      patch: {
        nodes: [
          {
            path: 'Root',
            properties: { position: 'Vector2(9, 9)' },
          },
        ],
      },
    });

    const outcome = await processMergeOutboxRow(row, deps);
    assert.equal(outcome, 'applied');
    assert.deepEqual(deps.applied, ['outbox-1']);
    assert.match(fs.readFileSync(scene, 'utf8'), /Vector2\(9, 9\)/);
    assert.ok(deps.audits.includes('merge.outbox_applied'));
  });

  it('remote row triggers workflow dispatch mock with secretJwe', async () => {
    const deps = mockDeps({
      async buildDispatchEnvelope({ row, projectRoot, patchGetUrl, s3Key }) {
        return {
          workflowInputs: {
            secretJwe: 'jwe.fake.payload',
            outboxId: row.id,
            projectId: row.project_id,
            path: row.path,
            projectRoot,
            patchGetUrl,
            s3Key,
          },
          sealed: {
            hasSecretJwe: true as const,
            targetHost: 'user@target',
            projectRoot,
            outboxId: row.id,
            relPath: row.path,
            patchGetUrl,
            hasSshPrivateKey: true,
            hasCallbackToken: true,
            pgosBaseUrl: 'https://pgos.example',
          },
        };
      },
    });
    const row = baseRow({
      project_root: '/var/godot/projects/remote-only',
      metadata: { targetHost: 'user@target', targetProvisionUrl: 'http://t/v1/provision' },
    });
    const outcome = await processMergeOutboxRow(row, deps);
    assert.equal(outcome, 'dispatched');
    assert.equal(deps.dispatches.length, 1);
    assert.equal(deps.dispatches[0]!.outboxId, 'outbox-1');
    assert.equal(deps.dispatches[0]!.secretJwe, 'jwe.fake.payload');
    assert.ok(deps.dispatches[0]!.patchGetUrl.includes('s3.example'));
    // No raw PEM in dispatch inputs
    for (const [k, v] of Object.entries(deps.dispatches[0]!)) {
      if (k === 'secretJwe') continue;
      assert.doesNotMatch(String(v), /BEGIN .*PRIVATE KEY/);
    }
    assert.deepEqual(deps.dispatched, ['outbox-1']);
    assert.ok(deps.audits.includes('merge.outbox_dispatched'));
  });

  it('failed apply sets failed status with detail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-merge-fail-'));
    // root exists but scene missing → 404 → failed
    const deps = mockDeps({
      pathIsReadableDir: async () => true,
    });
    const row = baseRow({
      project_root: root,
      path: 'scenes/missing.tscn',
    });
    const outcome = await processMergeOutboxRow(row, deps);
    assert.equal(outcome, 'failed');
    assert.equal(deps.failed.length, 1);
    assert.match(deps.failed[0]!.detail, /not found|Base/i);
  });

  it('processPendingMergeOutbox aggregates counts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-merge-batch-'));
    const scene = path.join(root, 'a.tscn');
    fs.writeFileSync(scene, '[gd_scene format=3]\n[node name="N" type="Node"]\n', 'utf8');

    const rows = [
      baseRow({
        id: 'a',
        project_root: root,
        path: 'a.tscn',
        patch: { nodes: [{ path: 'N', properties: { z: '1' } }] },
      }),
      baseRow({
        id: 'b',
        project_root: '/remote/p',
        metadata: { targetHost: 'h' },
      }),
    ];
    const deps = mockDeps({
      async listPending() {
        return rows;
      },
      pathIsReadableDir: async (d) => d === root,
      async buildDispatchEnvelope({ row, projectRoot, patchGetUrl, s3Key }) {
        return {
          workflowInputs: {
            secretJwe: 'jwe.batch',
            outboxId: row.id,
            projectId: row.project_id,
            path: row.path,
            projectRoot,
            patchGetUrl,
            s3Key,
          },
          sealed: {
            hasSecretJwe: true as const,
            targetHost: 'h',
            projectRoot,
            outboxId: row.id,
            relPath: row.path,
            patchGetUrl,
            hasSshPrivateKey: false,
            hasCallbackToken: true,
            pgosBaseUrl: 'https://pgos.example',
          },
        };
      },
    });
    const result = await processPendingMergeOutbox(deps, 10);
    assert.equal(result.applied, 1);
    assert.equal(result.dispatched, 1);
    assert.equal(result.failed, 0);
    assert.equal(deps.dispatches[0]?.secretJwe, 'jwe.batch');
  });

  it('unsupported non-tscn path fails with E014 path', async () => {
    const deps = mockDeps({
      pathIsReadableDir: async () => true,
    });
    const outcome = await processMergeOutboxRow(
      baseRow({ path: 'scenes/main.tres', project_root: '/tmp/x' }),
      deps,
    );
    assert.equal(outcome, 'failed');
    assert.match(deps.failed[0]!.detail, /unsupported path/);
  });
});
