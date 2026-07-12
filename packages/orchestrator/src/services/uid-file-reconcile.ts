/**
 * File-system UID scan + safe rewrite for nightly reconcile (H-03).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { audit } from './audit-service.js';

const SCAN_EXTS = new Set(['.tscn', '.tres', '.import', '.gd', '.cfg']);

/** Match full uid:// tokens (Godot-style). */
const UID_TOKEN_RE = /uid:\/\/[A-Za-z0-9_-]+/g;

export async function walkProjectFiles(
  projectRoot: string,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // skip .godot heavy cache except imported meta is under .import often at root
        if (e.name === '.godot') continue;
        await walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SCAN_EXTS.has(ext) || e.name.endsWith('.uid')) {
          out.push(full);
        }
      }
    }
  }
  await walk(projectRoot);
  return out;
}

export async function scanProjectForUids(
  projectRoot: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const files = await walkProjectFiles(projectRoot);
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const matches = text.match(UID_TOKEN_RE) ?? [];
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
    for (const uid of matches) {
      const list = map.get(uid) ?? [];
      if (!list.includes(rel)) list.push(rel);
      map.set(uid, list);
    }
  }
  return map;
}

/**
 * Replace full uid:// tokens only (no partial matches).
 */
export function rewriteUidsInText(
  content: string,
  replacements: Map<string, string>,
): { text: string; count: number } {
  let count = 0;
  const text = content.replace(UID_TOKEN_RE, (tok) => {
    const next = replacements.get(tok);
    if (next && next !== tok) {
      count++;
      return next;
    }
    return tok;
  });
  return { text, count };
}

export async function applyUidReplacements(
  projectRoot: string,
  replacements: Map<string, string>,
): Promise<{ filesTouched: string[]; replacements: number }> {
  if (replacements.size === 0) {
    return { filesTouched: [], replacements: 0 };
  }
  const files = await walkProjectFiles(projectRoot);
  const filesTouched: string[] = [];
  let total = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { text: next, count } = rewriteUidsInText(text, replacements);
    if (count > 0) {
      await fs.writeFile(file, next, 'utf8');
      filesTouched.push(path.relative(projectRoot, file).replace(/\\/g, '/'));
      total += count;
    }
  }
  return { filesTouched, replacements: total };
}

export async function runGodotReimport(
  projectRoot: string,
  opts?: { godotBin?: string; timeoutMs?: number },
): Promise<{ ok: boolean; detail?: string }> {
  const godot = opts?.godotBin ?? process.env.GODOT_BIN ?? 'godot';
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = spawn(
      godot,
      ['--headless', '--editor', '--quit', '--path', projectRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, detail: 'godot reimport timeout' });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !/uid:\/\/.*error|Failed to load resource/i.test(out)) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          detail: `godot exit ${code}: ${out.slice(0, 500)}`,
        });
      }
    });
  });
}

export async function reconcileProjectFiles(opts: {
  projectId: string;
  projectRoot: string;
  replacements: Map<string, string>;
  runGodot?: boolean;
}): Promise<{
  filesTouched: string[];
  replacements: number;
  godotOk?: boolean;
  mode: 'local' | 'remote_script';
  detail?: string;
}> {
  const rootReadable = await fs
    .stat(opts.projectRoot)
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (!rootReadable) {
    await audit({
      action: 'uid.nightly_reconcile',
      resourceType: 'project',
      resourceId: opts.projectId,
      detail: {
        mode: 'remote_script',
        note: 'project_root not local; use workers/scripts/uid-reconcile.sh on host',
        replacementCount: opts.replacements.size,
      },
    });
    return {
      filesTouched: [],
      replacements: 0,
      mode: 'remote_script',
      detail: 'project_root not readable on orchestrator',
    };
  }

  const { filesTouched, replacements } = await applyUidReplacements(
    opts.projectRoot,
    opts.replacements,
  );

  let godotOk: boolean | undefined;
  let detail: string | undefined;
  if (opts.runGodot !== false && replacements > 0) {
    const g = await runGodotReimport(opts.projectRoot);
    godotOk = g.ok;
    detail = g.detail;
    if (!g.ok) {
      await audit({
        action: 'uid.nightly_reconcile',
        resourceType: 'project',
        resourceId: opts.projectId,
        detail: {
          mode: 'local',
          fixed: replacements,
          filesTouched,
          godotOk: false,
          detail: g.detail,
          manual: true,
        },
      });
      return {
        filesTouched,
        replacements,
        godotOk: false,
        mode: 'local',
        detail: g.detail,
      };
    }
  }

  await audit({
    action: 'uid.nightly_reconcile',
    resourceType: 'project',
    resourceId: opts.projectId,
    detail: {
      mode: 'local',
      fixed: replacements,
      filesTouched,
      godotOk: godotOk ?? null,
    },
  });

  return { filesTouched, replacements, godotOk, mode: 'local', detail };
}
