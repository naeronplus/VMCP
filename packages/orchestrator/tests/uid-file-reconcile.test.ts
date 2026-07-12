import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyUidReplacements,
  rewriteUidsInText,
  scanProjectForUids,
} from '../src/services/uid-file-reconcile.js';

describe('UID file reconcile (H-03)', () => {
  it('rewrites full uid:// tokens only', () => {
    const map = new Map([['uid://abc123', 'uid://NEW999']]);
    const { text, count } = rewriteUidsInText(
      'x = uid://abc123\ny = uid://abc123extra\nz = "uid://abc123"',
      map,
    );
    assert.equal(count, 2);
    assert.match(text, /uid:\/\/NEW999/);
    assert.match(text, /uid:\/\/abc123extra/);
  });

  it('scans and rewrites fixture project files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgos-uid-'));
    const a = path.join(root, 'a.tscn');
    const b = path.join(root, 'sub', 'b.tres');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, '[node name="A"]\nuid = uid://DUPxxxx\n', 'utf8');
    fs.writeFileSync(b, 'ext = uid://DUPxxxx\n', 'utf8');

    const scan = await scanProjectForUids(root);
    assert.ok(scan.get('uid://DUPxxxx')?.length === 2);

    const { filesTouched, replacements } = await applyUidReplacements(
      root,
      new Map([['uid://DUPxxxx', 'uid://GEN_fixed']]),
    );
    assert.equal(filesTouched.length, 2);
    assert.equal(replacements, 2);
    assert.match(fs.readFileSync(a, 'utf8'), /uid:\/\/GEN_fixed/);
    assert.match(fs.readFileSync(b, 'utf8'), /uid:\/\/GEN_fixed/);
  });
});
