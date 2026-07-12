/**
 * Minimal semver range checks for extension Godot compatibility (§10.3).
 * Supports: exact, >=x.y.z, <x.y.z, and comma-separated conjunctions.
 * Also: exact Godot editor/template version equality for E006 (H-09/H-10).
 */

export type SemVerTriple = [number, number, number];

/**
 * Parse a version string into major.minor.patch.
 * Strips leading `v`, trailing channel suffixes (`.stable`, `-stable`, `.official`, …),
 * and ignores non-numeric tail segments.
 */
export function parseVersion(v: string): SemVerTriple {
  const cleaned = v
    .trim()
    .replace(/^v/i, '')
    // Godot often prints: 4.3.1.stable.official.for_editor
    .replace(/[._-](stable|official|dev|rc\d*|beta\d*|alpha\d*|mono).*$/i, '')
    .replace(/-stable.*$/i, '');
  const core = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!core) {
    return [0, 0, 0];
  }
  return [
    parseInt(core[1]!, 10) || 0,
    parseInt(core[2] ?? '0', 10) || 0,
    parseInt(core[3] ?? '0', 10) || 0,
  ];
}

function cmp(a: SemVerTriple, b: SemVerTriple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
}

/** Exact major.minor.patch equality (4.3.1 ≠ 4.3.10). */
export function versionsEqual(a: string, b: string): boolean {
  return cmp(parseVersion(a), parseVersion(b)) === 0;
}

/**
 * Extract the first semver-like token from `godot --version` output.
 * Examples:
 *   "4.3.1.stable.official.for_editor" → "4.3.1"
 *   "Godot Engine v4.2.2.stable.official" → "4.2.2"
 */
export function extractSemverFromGodotOutput(line: string): string | null {
  const text = line.trim().replace(/\r/g, '');
  // Prefer vX.Y.Z or bare X.Y.Z at start / after "v"
  const m =
    text.match(/\bv?(\d+\.\d+\.\d+)\b/) ??
    text.match(/\bv?(\d+\.\d+)\b/) ??
    text.match(/\bv?(\d+)\b/);
  return m ? m[1]! : null;
}

export function formatSemVer(v: SemVerTriple): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

export function satisfiesGodotRange(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const clauses = range.split(',').map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return true;

  for (const clause of clauses) {
    if (clause.startsWith('>=')) {
      if (cmp(ver, parseVersion(clause.slice(2))) < 0) return false;
    } else if (clause.startsWith('<=')) {
      if (cmp(ver, parseVersion(clause.slice(2))) > 0) return false;
    } else if (clause.startsWith('>')) {
      if (cmp(ver, parseVersion(clause.slice(1))) <= 0) return false;
    } else if (clause.startsWith('<')) {
      if (cmp(ver, parseVersion(clause.slice(1))) >= 0) return false;
    } else if (clause.startsWith('=')) {
      if (cmp(ver, parseVersion(clause.slice(1))) !== 0) return false;
    } else {
      if (cmp(ver, parseVersion(clause)) !== 0) return false;
    }
  }
  return true;
}
