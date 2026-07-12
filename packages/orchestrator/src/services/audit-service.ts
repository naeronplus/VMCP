import type { Role } from '@vibrato/shared';
import { getPool } from '../db/pool.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
}

export async function audit(input: AuditInput): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.actorId ?? null,
      input.actorRole ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export async function listAuditLogs(opts: {
  limit?: number;
  resourceType?: string;
  resourceId?: string;
}): Promise<unknown[]> {
  const limit = opts.limit ?? 100;
  if (opts.resourceType && opts.resourceId) {
    const { rows } = await getPool().query(
      `SELECT * FROM audit_logs
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [opts.resourceType, opts.resourceId, limit],
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
