import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFencingToken,
  parseFencingToken,
  tokensMatch,
  isTokenValidForInstance,
} from './fencing.js';

describe('fencing tokens', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';

  it('formats and parses composite tokens', () => {
    const raw = formatFencingToken(id, 42);
    assert.equal(raw, `${id}:42`);
    const parsed = parseFencingToken(raw);
    assert.ok(parsed);
    assert.equal(parsed!.counter, 42);
    assert.equal(parsed!.instanceId, id);
  });

  it('rejects tokens from old instance after failover', () => {
    const oldToken = formatFencingToken(id, 10);
    const newId = '660e8400-e29b-41d4-a716-446655440000';
    assert.equal(isTokenValidForInstance(oldToken, newId), false);
    assert.equal(isTokenValidForInstance(oldToken, id), true);
  });

  it('matches equal tokens', () => {
    const a = formatFencingToken(id, 7);
    const b = formatFencingToken(id, 7);
    assert.equal(tokensMatch(a, b), true);
    assert.equal(tokensMatch(a, formatFencingToken(id, 8)), false);
  });
});
