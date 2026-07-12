import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors resolve-secrets.sh Python export logic for worker pipeline env vars.
 */
function parseSecretsResponse(body: string): Record<string, string> {
  const data = JSON.parse(body) as { secrets?: Record<string, unknown> };
  const secrets = data.secrets ?? {};
  const urls = (secrets.presignedUrls ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  const map: [string, unknown][] = [
    ['CALLBACK_TOKEN', secrets.callbackToken],
    ['FENCING_TOKEN', secrets.fencingToken],
    ['PGOS_LOCK_KEY', secrets.lockKey],
    ['PGOS_LOCK_OWNER', secrets.lockOwner],
    ['TARGET_PROJECT_ROOT', secrets.targetProjectRoot],
    ['TARGET_HOST', secrets.targetHost],
    // L-05
    ['REIMPORT_TIMEOUT_SEC', secrets.reimportTimeoutSec],
    ['REIMPORT_MAX_RETRIES', secrets.reimportMaxRetries],
    ['PRESIGN_STAGING_PUT', urls.stagingPut],
    ['PRESIGN_STAGING_GET', urls.stagingGet],
    ['PRESIGN_STAGING_ARCHIVE_PUT', urls.stagingArchivePut],
    ['PRESIGN_VALIDATION_PUT', urls.validationPut],
    ['PRESIGN_SNAPSHOT_PUT', urls.snapshotPut],
    ['PRESIGN_SNAPSHOT_GET', urls.snapshotGet],
    ['PRESIGN_DIAGNOSTICS_PUT', urls.diagnosticsPut],
  ];
  for (const [key, val] of map) {
    if (val != null && val !== '') out[key] = String(val);
  }
  return out;
}

describe('worker secrets parse (resolve-secrets.sh)', () => {
  it('exports presigned URLs and fencing token from resolve-secret response', () => {
    const body = JSON.stringify({
      secrets: {
        callbackToken: 'cb-tok',
        fencingToken: 'fence-1',
        lockKey: 'gen:proj-1',
        lockOwner: 'job:abc',
        targetProjectRoot: '/var/godot/projects/p1',
        reimportTimeoutSec: 300,
        reimportMaxRetries: 2,
        presignedUrls: {
          stagingGet: 'https://s3/staging-get',
          stagingPut: 'https://s3/staging-put',
          validationPut: 'https://s3/validation',
          snapshotPut: 'https://s3/snapshot-put',
          snapshotGet: 'https://s3/snapshot-get',
        },
      },
    });
    const env = parseSecretsResponse(body);
    assert.equal(env.CALLBACK_TOKEN, 'cb-tok');
    assert.equal(env.FENCING_TOKEN, 'fence-1');
    assert.equal(env.PRESIGN_STAGING_GET, 'https://s3/staging-get');
    assert.equal(env.PRESIGN_SNAPSHOT_GET, 'https://s3/snapshot-get');
    assert.equal(env.TARGET_PROJECT_ROOT, '/var/godot/projects/p1');
    assert.equal(env.REIMPORT_TIMEOUT_SEC, '300');
    assert.equal(env.REIMPORT_MAX_RETRIES, '2');
  });

  it('omits empty optional fields', () => {
    const env = parseSecretsResponse(JSON.stringify({ secrets: { callbackToken: 'x' } }));
    assert.equal(env.CALLBACK_TOKEN, 'x');
    assert.equal(env.TARGET_HOST, undefined);
    assert.equal(env.PRESIGN_STAGING_GET, undefined);
  });
});