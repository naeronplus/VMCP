import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSemverFromGodotOutput,
  parseVersion,
  satisfiesGodotRange,
  versionsEqual,
} from './semver-range.js';

describe('semver range', () => {
  it('checks Godot version ranges', () => {
    assert.equal(satisfiesGodotRange('4.3.1', '>=4.2, <4.4'), true);
    assert.equal(satisfiesGodotRange('4.1.0', '>=4.2, <4.4'), false);
    assert.equal(satisfiesGodotRange('4.4.0', '>=4.2, <4.4'), false);
    assert.equal(satisfiesGodotRange('4.3.1', '4.3.1'), true);
  });

  it('exact equality rejects substring false positives (H-09)', () => {
    assert.equal(versionsEqual('4.3.1', '4.3.1'), true);
    assert.equal(versionsEqual('4.3.1', '4.3.10'), false);
    assert.equal(versionsEqual('4.3.10', '4.3.1'), false);
    assert.equal(versionsEqual('v4.3.1', '4.3.1.stable'), true);
    assert.equal(versionsEqual('4.2.2.stable.official', '4.2.2'), true);
  });

  it('parseVersion strips Godot channel suffixes', () => {
    assert.deepEqual(parseVersion('4.3.1.stable.official.for_editor'), [4, 3, 1]);
    assert.deepEqual(parseVersion('4.3.10-stable'), [4, 3, 10]);
  });

  it('extractSemverFromGodotOutput finds first X.Y.Z', () => {
    assert.equal(
      extractSemverFromGodotOutput('4.3.1.stable.official.for_editor'),
      '4.3.1',
    );
    assert.equal(
      extractSemverFromGodotOutput('Godot Engine v4.2.2.stable.official'),
      '4.2.2',
    );
    assert.equal(extractSemverFromGodotOutput('not a version'), null);
  });

  it('4.3.10 does not equal requested 4.3.1 (grep -F regression)', () => {
    // grep -F "4.3.1" would incorrectly match inside "4.3.10"
    const installed = '4.3.10.stable.official';
    const requested = '4.3.1';
    const extracted = extractSemverFromGodotOutput(installed);
    assert.ok(extracted);
    assert.equal(versionsEqual(extracted!, requested), false);
  });
});
