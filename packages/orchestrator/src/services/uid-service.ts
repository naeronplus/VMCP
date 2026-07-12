import crypto from 'node:crypto';
import {
  isSafeLogicalAssetPath,
  normalizeLogicalPath,
  PathTraversalError,
} from '@vibrato/shared';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool.js';
import { audit } from './audit-service.js';

/**
 * Central UID mapping with reservation locking (§5.1).
 */
export class UidService {
  /**
   * Acquire row-level lock on logical path; insert TMP- placeholder.
   * Concurrent requests for same path block until first commits or times out.
   */
  async reserve(opts: {
    projectId: string;
    logicalAssetPath: string;
    namespace?: 'GEN-' | 'OVRD-';
    jobId?: string;
    lockTimeoutMs?: number;
  }): Promise<{ id: string; uid: string; logicalAssetPath: string }> {
    const logical = normalizeLogicalPath(opts.logicalAssetPath);
    if (!isSafeLogicalAssetPath(logical)) {
      throw new PathTraversalError(`Unsafe logical asset path: ${opts.logicalAssetPath}`);
    }
    // namespace is applied on commit; reservation always uses TMP-
    void (opts.namespace ?? 'GEN-');
    const tmpUid = `uid://TMP-${cryptoRandom()}`;

    return withTransaction(async (client) => {
      // Advisory lock keyed by project+path to serialize reservations
      const lockId = hashToInt(`${opts.projectId}:${logical}`);
      const timeoutMs = opts.lockTimeoutMs ?? 30_000;
      const acquired = await waitForAdvisoryLock(client, lockId, timeoutMs);
      if (!acquired) {
        throw Object.assign(
          new Error(`UID reservation lock timeout after ${timeoutMs}ms for ${logical}`),
          { statusCode: 409, code: 'E008' },
        );
      }

      const existing = await client.query(
        `SELECT id, uid, namespace, reserved_by_job_id FROM uid_mappings
         WHERE project_id = $1 AND logical_asset_path = $2
         FOR UPDATE`,
        [opts.projectId, logical],
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.namespace === 'TMP-' && row.reserved_by_job_id && row.reserved_by_job_id !== opts.jobId) {
          // Another job holds reservation — wait is simulated by transaction lock
          // If still TMP after acquiring lock, steal only if no active job (simplified: reject)
          throw new Error(
            `UID path reserved by job ${row.reserved_by_job_id}; retry after that job completes`,
          );
        }
        if (row.namespace !== 'TMP-') {
          return {
            id: row.id,
            uid: row.uid,
            logicalAssetPath: logical,
          };
        }
        // Refresh our TMP reservation
        const { rows } = await client.query(
          `UPDATE uid_mappings
           SET uid = $1, namespace = 'TMP-', reserved_by_job_id = $2, updated_at = now()
           WHERE id = $3
           RETURNING id, uid`,
          [tmpUid, opts.jobId ?? null, row.id],
        );
        return { id: rows[0].id, uid: rows[0].uid, logicalAssetPath: logical };
      }

      const { rows } = await client.query(
        `INSERT INTO uid_mappings (project_id, logical_asset_path, uid, namespace, reserved_by_job_id)
         VALUES ($1, $2, $3, 'TMP-', $4)
         RETURNING id, uid`,
        [opts.projectId, logical, tmpUid, opts.jobId ?? null],
      );

      await audit({
        action: 'uid.reserved',
        resourceType: 'uid_mapping',
        resourceId: rows[0].id,
        detail: { projectId: opts.projectId, logical, tmpUid, jobId: opts.jobId },
      });

      return { id: rows[0].id, uid: rows[0].uid, logicalAssetPath: logical };
    });
  }

  async commitReservation(opts: {
    projectId: string;
    reservationId: string;
    finalUid: string;
    namespace?: 'GEN-' | 'OVRD-' | 'USER-';
  }): Promise<void> {
    const ns = opts.namespace ?? 'GEN-';
    const { rowCount } = await getPool().query(
      `UPDATE uid_mappings
       SET uid = $1, namespace = $2, reserved_by_job_id = NULL, updated_at = now()
       WHERE id = $3 AND project_id = $4`,
      [opts.finalUid, ns, opts.reservationId, opts.projectId],
    );
    if (rowCount === 0) {
      throw Object.assign(new Error('Reservation not found for this project'), {
        statusCode: 404,
      });
    }
    await audit({
      action: 'uid.committed',
      resourceType: 'uid_mapping',
      resourceId: opts.reservationId,
      detail: { finalUid: opts.finalUid, namespace: ns },
    });
  }

  async listForProject(projectId: string): Promise<unknown[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM uid_mappings WHERE project_id = $1 ORDER BY logical_asset_path`,
      [projectId],
    );
    return rows;
  }

  /**
   * Nightly reconciliation support: find duplicate UIDs and unmapped references.
   */
  async findDuplicates(projectId: string): Promise<
    { uid: string; paths: string[] }[]
  > {
    const { rows } = await getPool().query<{ uid: string; paths: string[] }>(
      `SELECT uid, array_agg(logical_asset_path) AS paths
       FROM uid_mappings
       WHERE project_id = $1 AND namespace <> 'TMP-'
       GROUP BY uid
       HAVING count(*) > 1`,
      [projectId],
    );
    return rows;
  }

  /**
   * Auto-resolve: keep canonical (newest), regenerate others.
   */
  async autoResolveDuplicates(projectId: string): Promise<{
    fixed: { oldUid: string; newUid: string; path: string }[];
    manual: { uid: string; paths: string[] }[];
  }> {
    const dups = await this.findDuplicates(projectId);
    const fixed: { oldUid: string; newUid: string; path: string }[] = [];
    const manual: { uid: string; paths: string[] }[] = [];

    for (const group of dups) {
      const { rows } = await getPool().query(
        `SELECT id, logical_asset_path, namespace, updated_at
         FROM uid_mappings WHERE project_id = $1 AND uid = $2
         ORDER BY
           CASE WHEN namespace = 'OVRD-' THEN 0 ELSE 1 END,
           updated_at DESC`,
        [projectId, group.uid],
      );
      if (rows.length < 2) continue;
      // First is canonical
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.namespace === 'OVRD-') {
          manual.push({ uid: group.uid, paths: group.paths });
          continue;
        }
        const newUid = `uid://GEN-${cryptoRandom()}`;
        await getPool().query(
          `UPDATE uid_mappings SET uid = $1, updated_at = now() WHERE id = $2`,
          [newUid, row.id],
        );
        fixed.push({
          oldUid: group.uid,
          newUid,
          path: row.logical_asset_path,
        });
      }
    }

    if (fixed.length) {
      await audit({
        action: 'uid.auto_resolved',
        resourceType: 'project',
        resourceId: projectId,
        detail: { fixed },
      });
    }
    return { fixed, manual };
  }
}

function cryptoRandom(): string {
  return crypto.randomBytes(12).toString('hex');
}

function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

async function waitForAdvisoryLock(
  client: PoolClient,
  lockId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1::bigint) AS ok`,
      [lockId],
    );
    if (rows[0]?.ok) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export const uidService = new UidService();
