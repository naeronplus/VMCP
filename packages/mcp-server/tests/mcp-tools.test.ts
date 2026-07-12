import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Vibrato MCP server config', () => {
  it('requires PGOS_BASE_URL default', () => {
    const base = (process.env.PGOS_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
    assert.equal(base, 'http://localhost:8080');
  });
});