import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFencingToken, isTokenValidForInstance } from '@vibrato/shared';

/**
 * Mirrors LockService.validateFencingToken decision table after reclaim.
 * After ADMIN_RECLAIM / STALE_RECOVERED the latest ledger reason invalidates
 * all prior holders — commits with the old token must fail.
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

describe('fencing validate decision table', () => {
  const inst = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const owner = 'job:11111111-1111-1111-1111-111111111111';
  const token = formatFencingToken(inst, 5);

  it('accepts matching owner+token on ACQUIRED', () => {
    assert.equal(
      wouldAccept({
        latestReason: 'ACQUIRED',
        latestOwner: owner,
        latestToken: token,
        latestInstanceId: inst,
        currentInstanceId: inst,
        presentedOwner: owner,
        presentedToken: token,
      }),
      true,
    );
  });

  it('rejects after admin reclaim even if old token presented', () => {
    assert.equal(
      wouldAccept({
        latestReason: 'ADMIN_RECLAIM',
        latestOwner: 'system',
        latestToken: formatFencingToken(inst, 6),
        latestInstanceId: inst,
        currentInstanceId: inst,
        presentedOwner: owner,
        presentedToken: token,
      }),
      false,
    );
  });

  it('rejects after failover instance rotation', () => {
    const newInst = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    assert.equal(isTokenValidForInstance(token, newInst), false);
    assert.equal(
      wouldAccept({
        latestReason: 'ACQUIRED',
        latestOwner: owner,
        latestToken: token,
        latestInstanceId: inst,
        currentInstanceId: newInst,
        presentedOwner: owner,
        presentedToken: token,
      }),
      false,
    );
  });
});
