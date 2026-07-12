import { getPool } from '../db/pool.js';
import { audit } from './audit-service.js';

export type BaselineRow = {
  id: string;
  projectId: string;
  s3Key: string;
  checksum: string;
  createdAt: string;
};

function mapRow(row: Record<string, unknown>): BaselineRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    s3Key: String(row.s3_key),
    checksum: String(row.checksum),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export class BaselineService {
  async listForProject(projectId: string, limit = 50): Promise<BaselineRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM baselines WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  async getLatest(projectId: string): Promise<BaselineRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM baselines WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
  }

  async create(opts: {
    projectId: string;
    s3Key: string;
    checksum: string;
    actorId?: string;
  }): Promise<BaselineRow> {
    const { rows } = await getPool().query(
      `INSERT INTO baselines (project_id, s3_key, checksum)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [opts.projectId, opts.s3Key, opts.checksum],
    );
    const baseline = mapRow(rows[0] as Record<string, unknown>);
    await audit({
      actorId: opts.actorId,
      action: 'baseline.created',
      resourceType: 'baseline',
      resourceId: baseline.id,
      detail: { projectId: opts.projectId, s3Key: opts.s3Key, checksum: opts.checksum },
    });
    return baseline;
  }
}

export const baselineService = new BaselineService();