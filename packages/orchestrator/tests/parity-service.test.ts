import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateParityReport } from '../src/services/parity-service.js';

describe('evaluateParityReport (H-12 / H-13)', () => {
  it('H-13: skipped tier_a_unavailable does not emit E010', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'missing-a',
      tierBChecksum: 'abc123',
      tierADurationMs: 0,
      tierBDurationMs: 42,
      skipped: true,
      reason: 'tier_a_unavailable',
    });
    assert.equal(r.skipped, true);
    assert.equal(r.passed, false);
    assert.equal(r.emitE010, false);
    assert.equal(r.reason, 'tier_a_unavailable');
  });

  it('H-13: missing-a checksum without skipped flag still treated as skip (no E010)', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'missing-a',
      tierBChecksum: 'abc123',
      tierADurationMs: 0,
      tierBDurationMs: 10,
    });
    assert.equal(r.skipped, true);
    assert.equal(r.emitE010, false);
    assert.equal(r.reason, 'tier_a_unavailable');
  });

  it('H-12: reimport_failed_a fails with distinct reason and emits E010', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'deadbeef',
      tierBChecksum: 'deadbeef',
      tierADurationMs: 100,
      tierBDurationMs: 100,
      reason: 'reimport_failed_a',
    });
    assert.equal(r.passed, false);
    assert.equal(r.skipped, false);
    assert.equal(r.emitE010, true);
    assert.equal(r.reason, 'reimport_failed_a');
  });

  it('H-12: reimport_failed_b fails even if checksums would match', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'same',
      tierBChecksum: 'same',
      tierADurationMs: 1,
      tierBDurationMs: 1,
      reason: 'reimport_failed_b',
    });
    assert.equal(r.passed, false);
    assert.equal(r.emitE010, true);
    assert.equal(r.reason, 'reimport_failed_b');
  });

  it('H-12: reimport_failed_both emits E010', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'a',
      tierBChecksum: 'b',
      tierADurationMs: 1,
      tierBDurationMs: 1,
      reason: 'reimport_failed_both',
    });
    assert.equal(r.emitE010, true);
    assert.equal(r.reason, 'reimport_failed_both');
  });

  it('checksum match passes without alert', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'fff',
      tierBChecksum: 'fff',
      tierADurationMs: 5,
      tierBDurationMs: 6,
    });
    assert.equal(r.passed, true);
    assert.equal(r.skipped, false);
    assert.equal(r.emitE010, false);
    assert.equal(r.reason, null);
  });

  it('checksum mismatch emits E010 with checksum_mismatch reason', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'aaa',
      tierBChecksum: 'bbb',
      tierADurationMs: 5,
      tierBDurationMs: 6,
    });
    assert.equal(r.passed, false);
    assert.equal(r.skipped, false);
    assert.equal(r.emitE010, true);
    assert.equal(r.reason, 'checksum_mismatch');
  });

  it('tier_b_unavailable is a hard fail (not skip)', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'aaa',
      tierBChecksum: 'missing-b',
      tierADurationMs: 1,
      tierBDurationMs: 0,
      reason: 'tier_b_unavailable',
    });
    assert.equal(r.skipped, false);
    assert.equal(r.emitE010, true);
    assert.equal(r.reason, 'tier_b_unavailable');
  });

  it('explicit skipped with empty reason defaults to skipped', () => {
    const r = evaluateParityReport({
      tierAChecksum: 'x',
      tierBChecksum: 'y',
      tierADurationMs: 0,
      tierBDurationMs: 0,
      skipped: true,
    });
    assert.equal(r.skipped, true);
    assert.equal(r.emitE010, false);
    assert.equal(r.reason, 'skipped');
  });
});
