/**
 * Minimal semver range checks for extension Godot compatibility (§10.3).
 * Supports: exact, >=x.y.z, <x.y.z, and comma-separated conjunctions.
 */

function parseVersion(v: string): [number, number, number] {
  const cleaned = v.trim().replace(/^v/i, '');
  const parts = cleaned.split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
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
