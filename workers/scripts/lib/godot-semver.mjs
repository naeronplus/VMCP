/**
 * Exact Godot semver helpers for worker scripts (H-09/H-10).
 * Keep logic aligned with packages/shared/src/semver-range.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseVersion(v) {
  const cleaned = String(v)
    .trim()
    .replace(/^v/i, '')
    .replace(/[._-](stable|official|dev|rc\d*|beta\d*|alpha\d*|mono).*$/i, '')
    .replace(/-stable.*$/i, '');
  const core = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!core) return [0, 0, 0];
  return [
    parseInt(core[1], 10) || 0,
    parseInt(core[2] ?? '0', 10) || 0,
    parseInt(core[3] ?? '0', 10) || 0,
  ];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export function versionsEqual(a, b) {
  return cmp(parseVersion(a), parseVersion(b)) === 0;
}

export function extractSemverFromGodotOutput(line) {
  const text = String(line).trim().replace(/\r/g, '');
  const m =
    text.match(/\bv?(\d+\.\d+\.\d+)\b/) ??
    text.match(/\bv?(\d+\.\d+)\b/) ??
    text.match(/\bv?(\d+)\b/);
  return m ? m[1] : null;
}

export function formatSemVer(triple) {
  return `${triple[0]}.${triple[1]}.${triple[2]}`;
}

/**
 * Candidate export template directories for a requested Godot version.
 */
export function templateDirCandidates(version, env = process.env) {
  const v = formatSemVer(parseVersion(version));
  const home = env.HOME || env.USERPROFILE || '';
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return [
    path.join(home, '.local', 'share', 'godot', 'export_templates', `${v}.stable`),
    path.join(home, 'Library', 'Application Support', 'Godot', 'export_templates', `${v}.stable`),
    path.join(
      env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'Godot',
      'export_templates',
      `${v}.stable`,
    ),
    path.join(workspace, '.godot-cache', 'export_templates', `${v}.stable`),
    path.join(workspace, '.godot-cache', 'templates', `${v}.stable`),
  ];
}

/**
 * Validate export templates exist and match the requested version.
 * @returns {{ ok: true, dir: string } | { ok: false, reason: string }}
 */
export function validateExportTemplates(version, env = process.env) {
  const want = formatSemVer(parseVersion(version));
  const candidates = templateDirCandidates(version, env);
  let foundDir = null;

  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        foundDir = dir;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!foundDir) {
    return {
      ok: false,
      reason: `export templates missing for ${want}.stable (searched: ${candidates.join('; ')})`,
    };
  }

  const versionTxt = path.join(foundDir, 'version.txt');
  if (fs.existsSync(versionTxt)) {
    const raw = fs.readFileSync(versionTxt, 'utf8').trim().split(/\r?\n/)[0] ?? '';
    if (raw && !versionsEqual(raw, want)) {
      return {
        ok: false,
        reason: `export template version.txt mismatch: ${raw} != ${want} (dir=${foundDir})`,
      };
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(foundDir);
  } catch (err) {
    return { ok: false, reason: `cannot read template dir ${foundDir}: ${err.message}` };
  }

  const meaningful = entries.filter(
    (e) => e !== 'version.txt' && !e.startsWith('.') && e !== 'desktop.ini',
  );
  if (meaningful.length === 0) {
    return {
      ok: false,
      reason: `export template dir empty: ${foundDir}`,
    };
  }

  return { ok: true, dir: foundDir };
}

function isMain() {
  try {
    const self = fileURLToPath(import.meta.url);
    return path.resolve(process.argv[1] ?? '') === path.resolve(self);
  } catch {
    return false;
  }
}

if (isMain()) {
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'check-version') {
    const [requested, installedLine] = args;
    if (!requested || installedLine === undefined) {
      console.error('usage: godot-semver.mjs check-version <requested> <installedLine>');
      process.exit(2);
    }
    const extracted = extractSemverFromGodotOutput(installedLine);
    if (!extracted) {
      console.error(
        JSON.stringify({
          ok: false,
          kind: 'version',
          detail: `cannot parse semver from godot --version: ${installedLine}`,
        }),
      );
      process.exit(1);
    }
    if (!versionsEqual(extracted, requested)) {
      console.error(
        JSON.stringify({
          ok: false,
          kind: 'version',
          detail: `version ${extracted} != ${formatSemVer(parseVersion(requested))} (raw installed: ${installedLine})`,
          installed: extracted,
          requested: formatSemVer(parseVersion(requested)),
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        ok: true,
        kind: 'version',
        installed: extracted,
        requested: formatSemVer(parseVersion(requested)),
      }),
    );
    process.exit(0);
  }

  if (cmd === 'check-templates') {
    const [requested] = args;
    if (!requested) {
      console.error('usage: godot-semver.mjs check-templates <requested>');
      process.exit(2);
    }
    const result = validateExportTemplates(requested);
    if (!result.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          kind: 'templates',
          detail: result.reason,
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        ok: true,
        kind: 'templates',
        dir: result.dir,
        requested: formatSemVer(parseVersion(requested)),
      }),
    );
    process.exit(0);
  }

  console.error('usage: godot-semver.mjs check-version|check-templates ...');
  process.exit(2);
}
