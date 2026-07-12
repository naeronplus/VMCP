import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTscnPatch,
  mergeTscn,
  parseTscn,
  serializeTscn,
} from '../src/services/tscn-merge.js';
import { patchIntroducesScript } from '../src/services/merge-service.js';

const BASE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_p" uid="uid://oldscript"]

[node name="Root" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="Root"]
position = Vector2(0, 0)
script = ExtResource("1_p")
`;

describe('structural tscn merge (H-02)', () => {
  it('merges node properties by path (golden)', () => {
    const merged = applyTscnPatch(BASE, {
      nodes: [
        {
          path: 'Root/Player',
          properties: { position: 'Vector2(10, 0)' },
        },
      ],
    });
    assert.match(merged, /position = Vector2\(10, 0\)/);
    assert.match(merged, /\[node name="Player"/);
    assert.match(merged, /script = ExtResource\("1_p"\)/);
  });

  it('adds new nodes from patch', () => {
    const merged = applyTscnPatch(BASE, {
      nodes: [
        {
          path: 'Root/Enemy',
          type: 'Node2D',
          parent: 'Root',
          properties: { position: 'Vector2(1, 2)' },
        },
      ],
    });
    assert.match(merged, /\[node name="Enemy" type="Node2D" parent="Root"\]/);
    assert.match(merged, /position = Vector2\(1, 2\)/);
  });

  it('deletes nodes when delete flag set', () => {
    const merged = applyTscnPatch(BASE, {
      nodes: [{ path: 'Root/Player', delete: true }],
    });
    assert.doesNotMatch(merged, /name="Player"/);
  });

  it('merges ext_resource by uid', () => {
    const merged = applyTscnPatch(BASE, {
      ext_resources: [
        {
          uid: 'uid://oldscript',
          path: 'res://enemy.gd',
        },
      ],
    });
    assert.match(merged, /path="res:\/\/enemy\.gd"/);
    assert.match(merged, /uid="uid:\/\/oldscript"/);
  });

  it('round-trips parse/serialize structure', () => {
    const ast = parseTscn(BASE);
    const again = parseTscn(serializeTscn(ast));
    assert.equal(again.sections.length, ast.sections.length);
  });

  it('script property in nodes still trips threat model', () => {
    assert.equal(
      patchIntroducesScript({
        nodes: [{ path: 'Root/Player', properties: { script: 'ExtResource("2")' } }],
      }),
      true,
    );
  });

  it('mergeTscn does not invent scripts from empty patch', () => {
    const out = mergeTscn(parseTscn(BASE), { nodes: [] });
    assert.match(serializeTscn(out), /player\.gd/);
  });
});
