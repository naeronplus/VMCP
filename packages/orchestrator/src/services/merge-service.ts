import type { MergeOverrideRequest, Role } from '@vibrato/shared';
import { assertWithinBase, isSafeLogicalAssetPath } from '@vibrato/shared';
import { getPool } from '../db/pool.js';
import { audit } from './audit-service.js';

/**
 * Override merge with script-injection threat model (§9.3).
 * Introducing script properties requires admin scope.
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
    }
  }
  return false;
}

export async function applyMerge(
  req: MergeOverrideRequest,
  actor: { userId: string; role: Role },
  projectRoot: string,
): Promise<{ id: string; introducesScript: boolean }> {
  if (!isSafeLogicalAssetPath(req.path)) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400, code: 'E014' });
  }
  // Ensure path cannot escape project root when joined
  assertWithinBase(projectRoot, req.path);

  const introducesScript = patchIntroducesScript(req.patch);
  if (introducesScript && actor.role !== 'admin') {
    throw Object.assign(
      new Error('Override introduces executable script; admin scope required'),
      { statusCode: 403, code: 'E019' },
    );
  }

  const { rows } = await getPool().query(
    `INSERT INTO overrides (project_id, path, patch, introduces_script, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      req.projectId,
      req.path,
      JSON.stringify(req.patch),
      introducesScript,
      actor.userId,
    ],
  );

  await audit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: introducesScript ? 'merge.script_override' : 'merge.override',
    resourceType: 'override',
    resourceId: rows[0].id,
    detail: { path: req.path, introducesScript },
  });

  return { id: rows[0].id, introducesScript };
}
