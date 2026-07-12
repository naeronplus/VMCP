package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	paths "github.com/vibrato/pgos/commit-agent/internal"
)

// maxMergePatchBytes caps JSON patch size on stdin (H-02 merge-apply).
const maxMergePatchBytes = 1 << 20 // 1 MiB

// handleMergeApply applies a structural .tscn patch from stdin.
//
//	merge-apply <project_root> <rel_path>
//
// stdout (success): single JSON line {"ok":true,"mergedHash":"<sha256>","path":"<rel>"}
// stderr + non-zero: failure (E014-class path errors, E019 script patches, merge I/O).
func (a *Agent) handleMergeApply(parts []string, stdin io.Reader) (int, string) {
	if len(parts) != 3 {
		return 1, "usage: merge-apply <project_root> <rel_path>"
	}
	projectRoot, err := paths.ValidateTarget(parts[1], a.cfg.ProjectRoot)
	if err != nil {
		return 1, "E014: " + err.Error()
	}
	relPath := strings.TrimSpace(parts[2])
	if relPath == "" || strings.Contains(relPath, "..") || filepath.IsAbs(relPath) {
		return 1, "E014: rel_path must be a relative path without traversal"
	}
	// Normalize to forward-slash logical path for response; FS uses OS separators.
	relPath = filepath.ToSlash(filepath.Clean(relPath))
	if strings.HasPrefix(relPath, "../") || relPath == ".." || strings.HasPrefix(relPath, "/") {
		return 1, "E014: rel_path must be a relative path without traversal"
	}

	target := filepath.Join(projectRoot, filepath.FromSlash(relPath))
	target, err = paths.ValidateTarget(target, a.cfg.ProjectRoot)
	if err != nil {
		return 1, "E014: " + err.Error()
	}
	// Also ensure under the specific project root (not a sibling project).
	if target != projectRoot && !strings.HasPrefix(target, projectRoot+string(filepath.Separator)) {
		return 1, "E014: target outside project_root"
	}

	limited := io.LimitReader(stdin, maxMergePatchBytes+1)
	patchBytes, err := io.ReadAll(limited)
	if err != nil {
		return 1, "read patch stdin: " + err.Error()
	}
	if len(patchBytes) > maxMergePatchBytes {
		return 1, fmt.Sprintf("patch exceeds max size %d bytes", maxMergePatchBytes)
	}
	if len(strings.TrimSpace(string(patchBytes))) == 0 {
		return 1, "empty patch on stdin"
	}

	var patch map[string]any
	if err := json.Unmarshal(patchBytes, &patch); err != nil {
		return 1, "invalid patch JSON: " + err.Error()
	}
	if patchIntroducesScript(patch) {
		// E019: script attachments require admin on orchestrator; agent never applies them.
		return 1, "E019: patch introduces executable script; rejected on target"
	}

	baseBytes, err := os.ReadFile(target)
	if err != nil {
		if os.IsNotExist(err) {
			return 1, "base .tscn not found: " + relPath
		}
		return 1, "read base: " + err.Error()
	}

	merged, err := applyTscnPatch(string(baseBytes), patch)
	if err != nil {
		return 1, "merge failed: " + err.Error()
	}

	sum := sha256.Sum256([]byte(merged))
	hash := hex.EncodeToString(sum[:])

	tmp := fmt.Sprintf("%s.pgos-merge-%d", target, os.Getpid())
	if err := os.WriteFile(tmp, []byte(merged), 0o644); err != nil {
		return 1, "write temp: " + err.Error()
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return 1, "atomic rename: " + err.Error()
	}

	out, _ := json.Marshal(map[string]any{
		"ok":         true,
		"mergedHash": hash,
		"path":       relPath,
	})
	a.slog.Printf("merge-apply ok path=%s hash=%s", relPath, hash)
	return 0, string(out)
}

// patchIntroducesScript mirrors orchestrator merge-service E019 gate.
func patchIntroducesScript(patch map[string]any) bool {
	raw, err := json.Marshal(patch)
	if err != nil {
		return true // fail closed
	}
	s := string(raw)
	if regexp.MustCompile(`(?i)"script"\s*:`).MatchString(s) {
		return true
	}
	if regexp.MustCompile(`(?i)ExtResource\s*\(`).MatchString(s) {
		return true
	}
	if strings.Contains(strings.ToLower(s), ".gd") && strings.Contains(strings.ToLower(s), "script") {
		return true
	}
	if nodes, ok := patch["nodes"].([]any); ok {
		for _, n := range nodes {
			nm, ok := n.(map[string]any)
			if !ok {
				continue
			}
			if _, has := nm["script"]; has {
				return true
			}
			if t, _ := nm["type"].(string); strings.EqualFold(t, "Script") {
				return true
			}
			if props, ok := nm["properties"].(map[string]any); ok {
				if _, has := props["script"]; has {
					return true
				}
			}
		}
	}
	return false
}

// --- Structural .tscn merge (port of workers/scripts/lib/tscn-merge.mjs) ---

type tscnSection struct {
	header string
	lines  []string
}

type tscnAST struct {
	preamble []string
	sections []tscnSection
}

func parseTscn(content string) tscnAST {
	raw := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	// Drop trailing empty split artifact only if content ended without newline? keep parity with JS
	var preamble []string
	var sections []tscnSection
	var current *tscnSection
	for _, line := range lines {
		if strings.HasPrefix(line, "[") {
			if current != nil {
				sections = append(sections, *current)
			}
			current = &tscnSection{header: line, lines: nil}
		} else if current != nil {
			current.lines = append(current.lines, line)
		} else {
			preamble = append(preamble, line)
		}
	}
	if current != nil {
		sections = append(sections, *current)
	}
	return tscnAST{preamble: preamble, sections: sections}
}

func serializeTscn(ast tscnAST) string {
	var b strings.Builder
	for i, line := range ast.preamble {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	for _, s := range ast.sections {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(s.header)
		for _, line := range s.lines {
			b.WriteByte('\n')
			b.WriteString(line)
		}
	}
	out := b.String()
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out
}

var headerAttrRe = regexp.MustCompile(`(\w+)="([^"]*)"`)

func parseHeaderAttrs(header string) map[string]string {
	attrs := make(map[string]string)
	for _, m := range headerAttrRe.FindAllStringSubmatch(header, -1) {
		attrs[m[1]] = m[2]
	}
	return attrs
}

func nodePathFromHeader(header string) string {
	if !strings.HasPrefix(header, "[node ") {
		return ""
	}
	attrs := parseHeaderAttrs(header)
	name := attrs["name"]
	if name == "" {
		return ""
	}
	parent := attrs["parent"]
	if parent == "" || parent == "." {
		return name
	}
	return strings.TrimPrefix(parent+"/"+name, "./")
}

var propLineRe = regexp.MustCompile(`^([A-Za-z_][\w/]*)\s*=\s*(.*)$`)

func setPropertyLines(lines []string, props map[string]any) []string {
	propMap := make(map[string]string)
	var order []string
	for _, line := range lines {
		if m := propLineRe.FindStringSubmatch(line); m != nil {
			if _, ok := propMap[m[1]]; !ok {
				order = append(order, m[1])
			}
			propMap[m[1]] = m[2]
		}
	}
	for k, v := range props {
		rendered := renderPropValue(v)
		if _, ok := propMap[k]; !ok {
			order = append(order, k)
		}
		propMap[k] = rendered
	}
	var nonProps []string
	for _, line := range lines {
		if !propLineRe.MatchString(line) && strings.TrimSpace(line) != "" {
			nonProps = append(nonProps, line)
		}
	}
	out := make([]string, 0, len(order)+len(nonProps))
	for _, k := range order {
		out = append(out, k+" = "+propMap[k])
	}
	out = append(out, nonProps...)
	return out
}

func renderPropValue(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		// JSON numbers — prefer integer form when whole
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return "null"
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(b)
	}
}

func normalizePatch(patch map[string]any) (nodes []map[string]any, ext []map[string]any) {
	if raw, ok := patch["nodes"].([]any); ok {
		for _, n := range raw {
			if m, ok := n.(map[string]any); ok {
				nodes = append(nodes, m)
			}
		}
	}
	if raw, ok := patch["ext_resources"].([]any); ok {
		for _, n := range raw {
			if m, ok := n.(map[string]any); ok {
				ext = append(ext, m)
			}
		}
	}
	for k, v := range patch {
		if k == "nodes" || k == "ext_resources" {
			continue
		}
		if m, ok := v.(map[string]any); ok {
			nodes = append(nodes, map[string]any{"path": k, "properties": m})
		}
	}
	return nodes, ext
}

func mergeTscn(base tscnAST, patch map[string]any) tscnAST {
	nodePatches, extPatches := normalizePatch(patch)
	sections := make([]tscnSection, len(base.sections))
	for i, s := range base.sections {
		lines := make([]string, len(s.lines))
		copy(lines, s.lines)
		sections[i] = tscnSection{header: s.header, lines: lines}
	}

	for _, ep := range extPatches {
		uid, _ := ep["uid"].(string)
		id, _ := ep["id"].(string)
		if uid == "" && id == "" {
			continue
		}
		found := false
		for i := range sections {
			if !strings.HasPrefix(sections[i].header, "[ext_resource ") {
				continue
			}
			attrs := parseHeaderAttrs(sections[i].header)
			if (uid != "" && attrs["uid"] == uid) || (id != "" && attrs["id"] == id) {
				found = true
				if t, ok := ep["type"].(string); ok && t != "" {
					attrs["type"] = t
				}
				if p, ok := ep["path"].(string); ok && p != "" {
					attrs["path"] = p
				}
				if uid != "" {
					attrs["uid"] = uid
				}
				if id != "" {
					attrs["id"] = id
				}
				// Stable-ish rebuild
				parts := make([]string, 0, len(attrs))
				for _, key := range []string{"type", "path", "uid", "id"} {
					if v, ok := attrs[key]; ok {
						parts = append(parts, fmt.Sprintf(`%s="%s"`, key, v))
						delete(attrs, key)
					}
				}
				for k, v := range attrs {
					parts = append(parts, fmt.Sprintf(`%s="%s"`, k, v))
				}
				sections[i].header = "[ext_resource " + strings.Join(parts, " ") + "]"
			}
		}
		if !found {
			typ, _ := ep["type"].(string)
			p, _ := ep["path"].(string)
			if typ != "" && p != "" {
				if id == "" {
					id = fmt.Sprintf("ext_%d", len(sections))
				}
				parts := []string{fmt.Sprintf(`type="%s"`, typ), fmt.Sprintf(`path="%s"`, p)}
				if uid != "" {
					parts = append(parts, fmt.Sprintf(`uid="%s"`, uid))
				}
				parts = append(parts, fmt.Sprintf(`id="%s"`, id))
				sections = append(sections, tscnSection{
					header: "[ext_resource " + strings.Join(parts, " ") + "]",
					lines:  nil,
				})
			}
		}
	}

	for _, np := range nodePatches {
		path := nodePatchPath(np)
		if path == "" {
			continue
		}
		if del, _ := np["delete"].(bool); del {
			for i, s := range sections {
				if strings.HasPrefix(s.header, "[node ") && nodePathFromHeader(s.header) == path {
					sections = append(sections[:i], sections[i+1:]...)
					break
				}
			}
			continue
		}
		idx := -1
		for i, s := range sections {
			if strings.HasPrefix(s.header, "[node ") && nodePathFromHeader(s.header) == path {
				idx = i
				break
			}
		}
		if idx >= 0 {
			if props, ok := np["properties"].(map[string]any); ok {
				sections[idx].lines = setPropertyLines(sections[idx].lines, props)
			}
			continue
		}
		name, _ := np["name"].(string)
		if name == "" {
			parts := strings.Split(path, "/")
			name = parts[len(parts)-1]
		}
		parent, _ := np["parent"].(string)
		if parent == "" {
			if strings.Contains(path, "/") {
				parent = path[:strings.LastIndex(path, "/")]
			} else {
				parent = "."
			}
		}
		typ, _ := np["type"].(string)
		if typ == "" {
			typ = "Node"
		}
		header := fmt.Sprintf(`[node name="%s" type="%s" parent="%s"]`, name, typ, parent)
		var lines []string
		if props, ok := np["properties"].(map[string]any); ok {
			lines = setPropertyLines(nil, props)
		}
		sections = append(sections, tscnSection{header: header, lines: lines})
	}

	preamble := make([]string, len(base.preamble))
	copy(preamble, base.preamble)
	return tscnAST{preamble: preamble, sections: sections}
}

func nodePatchPath(np map[string]any) string {
	if p, ok := np["path"].(string); ok && p != "" {
		return p
	}
	name, _ := np["name"].(string)
	parent, _ := np["parent"].(string)
	if name == "" {
		return ""
	}
	if parent == "" || parent == "." {
		return name
	}
	return parent + "/" + name
}

func applyTscnPatch(baseContent string, patch map[string]any) (string, error) {
	if patch == nil {
		return "", fmt.Errorf("nil patch")
	}
	return serializeTscn(mergeTscn(parseTscn(baseContent), patch)), nil
}
