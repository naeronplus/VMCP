import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { patchIntroducesScript } from '../src/services/merge-service.js';

describe('merge threat model', () => {
  it('detects script injection in overrides', () => {
    assert.equal(patchIntroducesScript({ position: { x: 1 } }), false);
    assert.equal(
      patchIntroducesScript({ script: 'ExtResource("1")' }),
      true,
    );
    assert.equal(
      patchIntroducesScript({
        nodes: [{ name: 'Player', script: 'res://player.gd' }],
      }),
      true,
    );
  });
});
