/**
 * Unit tests for workers/scripts/lib/godot-semver.mjs (H-09/H-10).
 * Run: node --test workers/tests/godot-semver.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractSemverFromGodotOutput,
  parseVersion,
  validateExportTemplates,
  versionsEqual,
} from '../scripts/lib/godot-semver.mjs';

describe('godot-semver worker helper', () => {
  it('rejects 4.3.10 when requesting 4.3.1 (substring false positive)', () => {
    const installed = '4.3.10.stable.official';
    const extracted = extractSemverFromGodotOutput(installed);
    assert.equal(extracted, '4.3.10');
    assert.equal(versionsEqual(extracted, '4.3.1'), false);
  });

  it('accepts matching versions with channel suffixes', () => {
    assert.equal(
      versionsEqual(
        extractSemverFromGodotOutput('4.3.1.stable.official.for_editor'),
        '4.3.1',
      ),
      true,
    );
  });

  it('parseVersion handles 4.3.10 vs 4.3.1', () => {
    assert.deepEqual(parseVersion('4.3.10'), [4, 3, 10]);
    assert.deepEqual(parseVersion('4.3.1'), [4, 3, 1]);
  });

  it('validateExportTemplates fails when dir missing', () => {
    const r = validateExportTemplates('9.9.9', {
      HOME: path.join(os.tmpdir(), 'no-such-home-pgos'),
      GITHUB_WORKSPACE: path.join(os.tmpdir(), 'no-such-ws-pgos'),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing/i);
  });

  it('validateExportTemplates accepts populated dir with version.txt', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-tpl-'));
    const dir = path.join(home, '.local', 'share', 'godot', 'export_templates', '4.3.1.stable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'version.txt'), '4.3.1.stable\n');
    fs.writeFileSync(path.join(dir, 'linux_release.x86_64'), 'stub');
    const r = validateExportTemplates('4.3.1', { HOME: home, GITHUB_WORKSPACE: home });
    assert.equal(r.ok, true);
    assert.equal(r.dir, dir);
  });

  it('validateExportTemplates rejects version.txt mismatch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-tpl-bad-'));
    const dir = path.join(home, '.local', 'share', 'godot', 'export_templates', '4.3.1.stable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'version.txt'), '4.3.10.stable\n');
    fs.writeFileSync(path.join(dir, 'linux_release.x86_64'), 'stub');
    const r = validateExportTemplates('4.3.1', { HOME: home, GITHUB_WORKSPACE: home });
    assert.equal(r.ok, false);
    assert.match(r.reason, /version\.txt mismatch/);
  });
});
