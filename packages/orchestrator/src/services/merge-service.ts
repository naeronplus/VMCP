import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MergeOverrideRequest, Role } from '@vibrato/shared';
import { assertWithinBase, isSafeLogicalAssetPath } from '@vibrato/shared';
import { getPool } from '../db/pool.js';
import { audit } from './audit-service.js';
import { applyTscnPatch, type TscnPatch } from './tscn-merge.js';

/**
 * Override merge with script-injection threat model (§9.3) + structural .tscn merge (H-02).
 */

export function patchIntroducesScript(patch: Record<string, unknown>): boolean {
  const json = JSON.stringify(patch);
  if (/"script"\s*:/i.test(json)) return true;
  if (/ExtResource\s*\(/i.test(json)) return true;
  if (/\.gd["']/i.test(json) && /script/i.test(json)) return true;
  if (patch.nodes && Array.isArray(patch.nodes)) {
    for (const n of patch.nodes as Record<string, unknown>[]) {
      if (n && typeof n === 'object' && ('script' in n || n.type === 'Script')) {
        return true;
      }
      if (n?.properties && typeof n.properties === 'object' && 'script' in (n.properties as object)) {
        return true;
      }
    }
  }
  return false;
}

export type MergeApplyMode = 'local_fs' | 'outbox' | 'registry_only';

/**
 * PGOS_STRUCTURAL_MERGE=0|false disables file writes (emergency).
 * PGOS_MERGE_MODE=local_fs|outbox|auto (default auto: local if readable).
 */
export function resolveMergeMode(
  _projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): MergeApplyMode {
  const structural =
    env.PGOS_STRUCTURAL_MERGE !== '0' && env.PGOS_STRUCTURAL_MERGE !== 'false';
  if (!structural) return 'registry_only';

  const forced = (env.PGOS_MERGE_MODE ?? 'auto').toLowerCase();
  if (forced === 'outbox') return 'outbox';
  if (forced === 'local_fs') return 'local_fs';
  if (forced === 'registry_only') return 'registry_only';
  // auto: attempt local_fs in applyMerge; fall back to outbox if root unreadable
  return 'local_fs';
}

async function pathIsReadableDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function applyMerge(
  req: MergeOverrideRequest,
  actor: { userId: string; role: Role },
  projectRoot: string,
): Promise<{
  id: string;
  introducesScript: boolean;
  applyMode: MergeApplyMode;
  mergedHash?: string;
  outboxId?: string;
}> {
  if (!isSafeLogicalAssetPath(req.path)) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400, code: 'E014' });
  }
  assertWithinBase(projectRoot, req.path);

  const introducesScript = patchIntroducesScript(req.patch);
  if (introducesScript && actor.role !== 'admin') {
    throw Object.assign(
      new Error('Override introduces executable script; admin scope required'),
      { statusCode: 403, code: 'E019' },
    );
  }

  let applyMode = resolveMergeMode(projectRoot);
  let mergedHash: string | undefined;
  let outboxId: string | undefined;

  const fullPath = path.resolve(projectRoot, req.path);
  // Re-validate resolved path
  assertWithinBase(projectRoot, req.path);

  const structuralOn =
    process.env.PGOS_STRUCTURAL_MERGE !== '0' &&
    process.env.PGOS_STRUCTURAL_MERGE !== 'false';

  if (structuralOn && applyMode === 'local_fs') {
    const rootOk = await pathIsReadableDir(projectRoot);
    if (!rootOk) {
      applyMode = 'outbox';
    } else if (req.path.endsWith('.tscn')) {
      try {
        const base = await fs.readFile(fullPath, 'utf8');
        const merged = applyTscnPatch(base, req.patch as TscnPatch);
        mergedHash = crypto.createHash('sha256').update(merged).digest('hex');
        const tmp = `${fullPath}.pgos-merge-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, merged, 'utf8');
        await fs.rename(tmp, fullPath);
        applyMode = 'local_fs';
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw Object.assign(
            new Error(
              `Base .tscn not found at ${req.path} — create the scene on the project host first`,
            ),
            { statusCode: 404, code: 'E014' },
          );
        }
        // Unreadable → fall back to outbox
        applyMode = 'outbox';
      }
    }
  }

  const { rows } = await getPool().query(
    `INSERT INTO overrides (project_id, path, patch, introduces_script, created_by, merged_hash, apply_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      req.projectId,
      req.path,
      JSON.stringify(req.patch),
      introducesScript,
      actor.userId,
      mergedHash ?? null,
      applyMode === 'registry_only' ? null : applyMode,
    ],
  );

  if (applyMode === 'outbox') {
    const { rows: ob } = await getPool().query(
      `INSERT INTO merge_outbox (override_id, project_id, path, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [rows[0].id, req.projectId, req.path],
    );
    outboxId = ob[0].id;
  }

  await audit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: introducesScript ? 'merge.script_override' : 'merge.override',
    resourceType: 'override',
    resourceId: rows[0].id,
    detail: {
      path: req.path,
      introducesScript,
      applyMode,
      mergedHash,
      outboxId,
    },
  });

  return {
    id: rows[0].id,
    introducesScript,
    applyMode,
    mergedHash,
    outboxId,
  };
}
