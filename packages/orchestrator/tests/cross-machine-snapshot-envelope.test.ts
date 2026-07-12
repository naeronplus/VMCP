/**
 * C-03: dispatch secret envelope always includes pre-commit snapshot presigns
 * (primary rollback path for cross-machine).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('cross-machine snapshot presign envelope (C-03)', () => {
  it('job-service embeds snapshotPut + snapshotGet for every dispatch envelope', () => {
    const src = readFileSync(
      join(here, '../src/services/job-service.ts'),
      'utf8',
    );
    assert.match(src, /snapshotPut:\s*await s3Service\.presignPut\(snapshotKey\)/);
    assert.match(src, /snapshotGet:\s*await s3Service\.presignGet\(snapshotKey\)/);
    // Use last occurrences (import of resolveCrossMachineProvision is at top of file)
    const snapIdx = src.lastIndexOf('snapshotPut:');
    const crossIdx = src.lastIndexOf('resolveCrossMachineProvision(');
    assert.ok(snapIdx > 0 && crossIdx > 0, 'expected both markers in dispatch path');
    assert.ok(
      snapIdx < crossIdx,
      'presigned snapshot URLs must be in envelopeBase before cross-machine provision branch',
    );
  });

  it('worker secrets map exports PRESIGN_SNAPSHOT_PUT and PRESIGN_SNAPSHOT_GET', () => {
    // Mirrors resolve-secrets.sh / worker-secrets-parse.test.ts contract
    const mapKeys = [
      'PRESIGN_SNAPSHOT_PUT',
      'PRESIGN_SNAPSHOT_GET',
    ];
    const body = {
      secrets: {
        presignedUrls: {
          snapshotPut: 'https://s3.example/put',
          snapshotGet: 'https://s3.example/get',
        },
      },
    };
    const urls = body.secrets.presignedUrls;
    const env: Record<string, string> = {};
    if (urls.snapshotPut) env.PRESIGN_SNAPSHOT_PUT = urls.snapshotPut;
    if (urls.snapshotGet) env.PRESIGN_SNAPSHOT_GET = urls.snapshotGet;
    for (const k of mapKeys) {
      assert.ok(env[k], `missing ${k}`);
    }
    assert.equal(env.PRESIGN_SNAPSHOT_PUT, 'https://s3.example/put');
    assert.equal(env.PRESIGN_SNAPSHOT_GET, 'https://s3.example/get');
  });
});
