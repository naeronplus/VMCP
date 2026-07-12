import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CATALOG } from '@vibrato/shared';
import { patchIntroducesScript } from '../src/services/merge-service.js';

/**
 * Mirrors merge-service script-override admin gate error (E019 only — M-02).
 */
function scriptOverrideRequiresAdminError() {
  return Object.assign(
    new Error('Override introduces executable script; admin scope required'),
    { statusCode: 403, code: 'E019' as const },
  );
}

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

  it('M-02: script override admin gate is E019 (403), not E021', () => {
    assert.equal(patchIntroducesScript({ script: 'res://x.gd' }), true);
    const err = scriptOverrideRequiresAdminError();
    assert.equal(err.code, 'E019');
    assert.equal(err.statusCode, ERROR_CATALOG.E019.httpStatus);
    assert.equal(err.statusCode, 403);
    assert.notEqual(err.code, 'E021');
    assert.equal(ERROR_CATALOG.E019.class, 'SCRIPT_OVERRIDE_REQUIRES_ADMIN');
  });

  it('merge-service source throws E019 for script gate (regression guard)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/services/merge-service.ts'), 'utf8');
    assert.match(
      src,
      /introduces executable script[\s\S]{0,120}code:\s*['"]E019['"]/,
    );
    assert.doesNotMatch(
      src,
      /introduces executable script[\s\S]{0,120}code:\s*['"]E021['"]/,
    );
  });
});
