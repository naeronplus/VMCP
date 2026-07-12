/**
 * H-03: uid-service remote dispatch wiring (plan §7.2.3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uidService } from '../src/services/uid-service.js';

describe('uid-service (H-03)', () => {
  it('reconcileProjectFilesAfterFix passes metadata to reconcile for remote dispatch', async () => {
    const calls: {
      projectId: string;
      projectRoot: string;
      metadata?: Record<string, unknown> | null;
    }[] = [];

    const result = await uidService.reconcileProjectFilesAfterFix({
      projectId: 'proj-remote',
      projectRoot: '/var/godot/projects/proj-remote',
      replacements: new Map([['uid://DUP', 'uid://GEN-new']]),
      metadata: {
        targetHost: 'user@target',
        targetProvisionUrl: 'http://127.0.0.1:9071/v1/provision',
      },
      loadMetadataFromDb: false,
      reconcileFiles: async (args) => {
        calls.push({
          projectId: args.projectId,
          projectRoot: args.projectRoot,
          metadata: args.metadata,
        });
        return {
          filesTouched: [],
          replacements: 0,
          mode: 'remote_dispatched',
          s3Key: 'projects/proj-remote/uid-reconcile/map.json',
          workflowRunId: 99,
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.projectId, 'proj-remote');
    assert.equal(calls[0]!.metadata?.targetHost, 'user@target');
    assert.equal(result.fileMode, 'remote_dispatched');
    assert.deepEqual(result.manual, []);
  });

  it('reconcileProjectFilesAfterFix surfaces dispatch failure as manual review', async () => {
    const result = await uidService.reconcileProjectFilesAfterFix({
      projectId: 'p1',
      projectRoot: '/remote/p',
      replacements: new Map([['uid://a', 'uid://b']]),
      metadata: { targetHost: 'h' },
      loadMetadataFromDb: false,
      reconcileFiles: async () => ({
        filesTouched: [],
        replacements: 0,
        mode: 'remote_script',
        detail: 'dispatch failed: github down',
      }),
    });

    assert.equal(result.fileMode, 'remote_script');
    assert.ok(
      result.manual.some((m) => m.uid === 'remote-uid-dispatch-failed'),
    );
  });

  it('autoResolveDuplicates source wires H-03 reconcileProjectFilesAfterFix', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/uid-service.ts'), 'utf8');
    assert.match(src, /reconcileProjectFilesAfterFix/);
    assert.match(src, /uid-file-reconcile/);
    assert.match(src, /remote_dispatched/);
  });
});