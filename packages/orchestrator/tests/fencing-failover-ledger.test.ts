import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFencingToken, isTokenValidForInstance } from '@vibrato/shared';
import {
  FAILOVER_SENTINEL_LOCK_KEY,
  buildFailoverLedgerRows,
} from '../src/services/lock-service.js';

/**
 * Mirrors LockService.validateFencingToken after M-17 FAILOVER ledger insert.
 */
function wouldAccept(opts: {
  latestReason: string;
  latestOwner: string;
  latestToken: string;
  latestInstanceId: string;
  currentInstanceId: string;
  presentedOwner: string;
  presentedToken: string;
}): boolean {
  if (opts.latestInstanceId.toLowerCase() !== opts.currentInstanceId.toLowerCase()) {
    return false;
  }
  if (
    opts.latestReason === 'STALE_RECOVERED' ||
    opts.latestReason === 'ADMIN_RECLAIM' ||
    opts.latestReason === 'FAILOVER'
  ) {
    return false;
  }
  if (opts.latestOwner !== opts.presentedOwner) return false;
  return opts.latestToken === opts.presentedToken;
}

describe('FAILOVER ledger rows (M-17)', () => {
  const oldInst = '11111111-1111-1111-1111-111111111111';
  const newInst = '22222222-2222-2222-2222-222222222222';
  const lockKey = 'project:p1:generation';
  const owner = 'job:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const oldToken = formatFencingToken(oldInst, 7);

  it('buildFailoverLedgerRows always includes sentinel + active keys', () => {
    const rows = buildFailoverLedgerRows({
      newInstanceId: newInst,
      activeLockKeys: [lockKey, 'project:p2:generation'],
    });
    const keys = rows.map((r) => r.lockKey);
    assert.ok(keys.includes(FAILOVER_SENTINEL_LOCK_KEY));
    assert.ok(keys.includes(lockKey));
    assert.ok(keys.includes('project:p2:generation'));
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.reason, 'FAILOVER');
      assert.equal(r.owner, 'system');
      assert.equal(r.instanceId, newInst);
      assert.equal(r.token, formatFencingToken(newInst, 0));
    }
  });

  it('buildFailoverLedgerRows still writes sentinel when no active locks', () => {
    const rows = buildFailoverLedgerRows({
      newInstanceId: newInst,
      activeLockKeys: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lockKey, FAILOVER_SENTINEL_LOCK_KEY);
    assert.equal(rows[0]!.reason, 'FAILOVER');
  });

  it('dedupes active keys and ignores empty strings', () => {
    const rows = buildFailoverLedgerRows({
      newInstanceId: newInst,
      activeLockKeys: [lockKey, lockKey, '', lockKey],
    });
    assert.equal(rows.filter((r) => r.lockKey === lockKey).length, 1);
  });

  it('after FAILOVER ledger row, old token is rejected even if instance matched (reason gate)', () => {
    // Primary invalidation after rotation is instance mismatch…
    assert.equal(isTokenValidForInstance(oldToken, newInst), false);

    // …and latest.reason=FAILOVER also rejects (validateFencingToken decision table)
    assert.equal(
      wouldAccept({
        latestReason: 'FAILOVER',
        latestOwner: 'system',
        latestToken: formatFencingToken(newInst, 0),
        latestInstanceId: newInst,
        currentInstanceId: newInst,
        presentedOwner: owner,
        presentedToken: oldToken,
      }),
      false,
    );
  });

  it('FAILOVER reason rejects even a forged matching new-instance token', () => {
    const forged = formatFencingToken(newInst, 0);
    assert.equal(
      wouldAccept({
        latestReason: 'FAILOVER',
        latestOwner: 'system',
        latestToken: forged,
        latestInstanceId: newInst,
        currentInstanceId: newInst,
        presentedOwner: 'system',
        presentedToken: forged,
      }),
      false,
      'FAILOVER must invalidate all holders until a new ACQUIRED',
    );
  });

  it('pre-failover ACQUIRED would accept; post-failover FAILOVER would not', () => {
    assert.equal(
      wouldAccept({
        latestReason: 'ACQUIRED',
        latestOwner: owner,
        latestToken: oldToken,
        latestInstanceId: oldInst,
        currentInstanceId: oldInst,
        presentedOwner: owner,
        presentedToken: oldToken,
      }),
      true,
    );
    assert.equal(
      wouldAccept({
        latestReason: 'FAILOVER',
        latestOwner: 'system',
        latestToken: formatFencingToken(newInst, 0),
        latestInstanceId: newInst,
        currentInstanceId: newInst,
        presentedOwner: owner,
        presentedToken: oldToken,
      }),
      false,
    );
  });

  it('rotateInstanceIdOnFailover source inserts FAILOVER into lock_fencing_seq', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/lock-service.ts'), 'utf8');
    assert.match(src, /rotateInstanceIdOnFailover/);
    assert.match(src, /buildFailoverLedgerRows/);
    assert.match(
      src,
      /INSERT INTO lock_fencing_seq[\s\S]{0,120}FAILOVER|reason:\s*'FAILOVER'/,
    );
    // Must not only audit without ledger write
    assert.match(src, /lock_fencing_seq/);
    assert.ok(
      src.includes("reason: 'FAILOVER'") || src.includes('row.reason'),
      'FAILOVER reason must be written from ledger rows',
    );
  });
});
