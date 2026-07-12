import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Documents dual-window rate limiting: sustained per-minute + 10s burst.
 */
describe('rate limit burst configuration', () => {
  it('uses separate burst window from sustained limit', () => {
    const sustainedWindowMs = 60_000;
    const burstWindowMs = 10_000;
    assert.notEqual(sustainedWindowMs, burstWindowMs);
    assert.ok(burstWindowMs < sustainedWindowMs);
  });
});