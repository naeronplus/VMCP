package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleTscn = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_script"]

[node name="Root" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="Root"]
position = Vector2(0, 0)
`

func writeFixtureProject(t *testing.T, root string) (projectRoot, rel string) {
	t.Helper()
	projectRoot = filepath.Join(root, "game")
	rel = "scenes/player.tscn"
	full := filepath.Join(projectRoot, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(sampleTscn), 0o644); err != nil {
		t.Fatal(err)
	}
	return projectRoot, rel
}

func TestMergeApply_HappyPath(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	projectRoot, rel := writeFixtureProject(t, root)

	patch := map[string]any{
		"nodes": []any{
			map[string]any{
				"path": "Root/Player",
				"properties": map[string]any{
					"position": "Vector2(10, 0)",
				},
			},
		},
	}
	raw, _ := json.Marshal(patch)
	code, msg := a.handleMergeApply([]string{"merge-apply", projectRoot, rel}, bytes.NewReader(raw))
	if code != 0 {
		t.Fatalf("merge-apply failed: %s", msg)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(msg), &out); err != nil {
		t.Fatalf("stdout not JSON: %v %s", err, msg)
	}
	if out["ok"] != true {
		t.Fatalf("expected ok true: %v", out)
	}
	if out["path"] != rel && out["path"] != filepath.ToSlash(rel) {
		t.Fatalf("path: %v", out["path"])
	}
	hash, _ := out["mergedHash"].(string)
	if len(hash) != 64 {
		t.Fatalf("mergedHash length: %s", hash)
	}

	got, err := os.ReadFile(filepath.Join(projectRoot, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "Vector2(10, 0)") {
		t.Fatalf("merged content missing position: %s", got)
	}
	sum := sha256.Sum256(got)
	if hex.EncodeToString(sum[:]) != hash {
		t.Fatalf("hash mismatch file vs response")
	}
	// no temp left behind
	matches, _ := filepath.Glob(filepath.Join(projectRoot, "scenes", "player.tscn.pgos-merge-*"))
	if len(matches) != 0 {
		t.Fatalf("temp files left: %v", matches)
	}
}

func TestMergeApply_BadPathTraversal(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	projectRoot, _ := writeFixtureProject(t, root)

	patch := []byte(`{"nodes":[]}`)
	code, msg := a.handleMergeApply(
		[]string{"merge-apply", projectRoot, "../outside.tscn"},
		bytes.NewReader(patch),
	)
	if code == 0 || !strings.Contains(msg, "E014") {
		t.Fatalf("expected E014, got code=%d msg=%s", code, msg)
	}

	code, msg = a.handleMergeApply(
		[]string{"merge-apply", filepath.Join(root, "..", "etc"), "x.tscn"},
		bytes.NewReader(patch),
	)
	if code == 0 || !strings.Contains(msg, "E014") {
		t.Fatalf("expected E014 outside root, got code=%d msg=%s", code, msg)
	}
}

func TestMergeApply_E019ScriptPatchReject(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	projectRoot, rel := writeFixtureProject(t, root)

	patch := map[string]any{
		"nodes": []any{
			map[string]any{
				"path": "Root/Player",
				"properties": map[string]any{
					"script": "ExtResource(\"1_script\")",
				},
			},
		},
	}
	raw, _ := json.Marshal(patch)
	code, msg := a.handleMergeApply([]string{"merge-apply", projectRoot, rel}, bytes.NewReader(raw))
	if code == 0 || !strings.Contains(msg, "E019") {
		t.Fatalf("expected E019 reject, got code=%d msg=%s", code, msg)
	}
	// file unchanged
	got, _ := os.ReadFile(filepath.Join(projectRoot, filepath.FromSlash(rel)))
	if string(got) != sampleTscn {
		t.Fatal("file should be unchanged after E019 reject")
	}
}

func TestMergeApply_UsageAndMissingBase(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	projectRoot := filepath.Join(root, "game")
	_ = os.MkdirAll(projectRoot, 0o755)

	code, msg := a.handleMergeApply([]string{"merge-apply", projectRoot}, bytes.NewReader(nil))
	if code == 0 || !strings.Contains(msg, "usage: merge-apply") {
		t.Fatalf("usage: %d %s", code, msg)
	}

	code, msg = a.handleMergeApply(
		[]string{"merge-apply", projectRoot, "missing.tscn"},
		bytes.NewReader([]byte(`{"nodes":[]}`)),
	)
	if code == 0 || !strings.Contains(msg, "not found") {
		t.Fatalf("missing base: %d %s", code, msg)
	}
}

func TestPatchIntroducesScript(t *testing.T) {
	if !patchIntroducesScript(map[string]any{
		"nodes": []any{map[string]any{"properties": map[string]any{"script": "x"}}},
	}) {
		t.Fatal("expected script property detect")
	}
	if patchIntroducesScript(map[string]any{
		"nodes": []any{map[string]any{"path": "Root/Player", "properties": map[string]any{"position": "Vector2(1, 2)"}}},
	}) {
		t.Fatal("operator property patch should not trip E019")
	}
}

func TestApplyTscnPatch_SetProperty(t *testing.T) {
	merged, err := applyTscnPatch(sampleTscn, map[string]any{
		"nodes": []any{
			map[string]any{
				"path":       "Root/Player",
				"properties": map[string]any{"position": "Vector2(3, 4)"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(merged, "Vector2(3, 4)") {
		t.Fatalf("merge miss: %s", merged)
	}
	if !strings.Contains(merged, `[node name="Player"`) {
		t.Fatalf("node lost: %s", merged)
	}
}

func TestHandleArgs_MergeApplyWired(t *testing.T) {
	root := t.TempDir()
	a := testAgent(t, root)
	projectRoot, rel := writeFixtureProject(t, root)
	// handleArgs reads os.Stdin — use handleMergeApply path via args when stdin empty fails
	// Wire check: verb is recognized
	old := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Stdin = old })
	os.Stdin = r
	go func() {
		_, _ = w.Write([]byte(`{"nodes":[{"path":"Root/Player","properties":{"position":"Vector2(9, 9)"}}]}`))
		_ = w.Close()
	}()
	code, msg := a.handleArgs([]string{"merge-apply", projectRoot, rel})
	if code != 0 {
		t.Fatalf("handleArgs merge-apply: %s", msg)
	}
	if !strings.Contains(msg, `"ok":true`) && !strings.Contains(msg, `"ok": true`) {
		// json.Marshal produces no spaces
		if !strings.Contains(msg, `"ok":true`) {
			t.Fatalf("expected ok json: %s", msg)
		}
	}
}
