/**
 * Filesystem apply helpers for structural .tscn merge (H-02).
 * Extracted so merge-service (inline) and merge-outbox-worker share one path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertWithinBase, isSafeLogicalAssetPath } from '@vibrato/shared';
import { applyTscnPatch, type TscnPatch } from './tscn-merge.js';

export type ApplyTscnResult = {
  fullPath: string;
  mergedHash: string;
  bytes: number;
};

/**
 * Read base .tscn under projectRoot, apply structural patch, atomic write.
 * Throws with statusCode 404 when base missing; 400 for unsafe paths.
 */
export async function applyTscnToFilesystem(
  projectRoot: string,
  relPath: string,
  patch: TscnPatch,
): Promise<ApplyTscnResult> {
  if (!isSafeLogicalAssetPath(relPath)) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400, code: 'E014' });
  }
  assertWithinBase(projectRoot, relPath);

  if (!relPath.endsWith('.tscn')) {
    throw Object.assign(
      new Error(`Structural merge only supports .tscn paths (got ${relPath})`),
      { statusCode: 400, code: 'E014' },
    );
  }

  const fullPath = path.resolve(projectRoot, relPath);
  assertWithinBase(projectRoot, relPath);

  let base: string;
  try {
    base = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw Object.assign(
        new Error(
          `Base .tscn not found at ${relPath} — create the scene on the project host first`,
        ),
        { statusCode: 404, code: 'E014' },
      );
    }
    throw err;
  }

  const merged = applyTscnPatch(base, patch);
  const mergedHash = crypto.createHash('sha256').update(merged).digest('hex');
  const tmp = `${fullPath}.pgos-merge-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, merged, 'utf8');
  await fs.rename(tmp, fullPath);

  return { fullPath, mergedHash, bytes: Buffer.byteLength(merged, 'utf8') };
}

export async function pathIsReadableDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
