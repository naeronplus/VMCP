import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { satisfiesGodotRange } from './semver-range.js';

describe('semver range', () => {
  it('checks Godot version ranges', () => {
    assert.equal(satisfiesGodotRange('4.3.1', '>=4.2, <4.4'), true);
    assert.equal(satisfiesGodotRange('4.1.0', '>=4.2, <4.4'), false);
    assert.equal(satisfiesGodotRange('4.4.0', '>=4.2, <4.4'), false);
    assert.equal(satisfiesGodotRange('4.3.1', '4.3.1'), true);
  });
});
