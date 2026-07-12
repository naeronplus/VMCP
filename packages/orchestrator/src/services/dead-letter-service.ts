/**
 * H-14 / M-03 — dead-letter consumer enrichment + escalation helpers.
 * Keeps load/enrich/notify logic testable outside BullMQ wiring.
 */
import { getPool } from '../db/pool.js';
import {
  buildDeadLetterEnteredBody,
  escalateDeadLetter,
  normalizeEmailList,
  sendAlert,
  type AlertMailDeps,
} from './alert-service.js';

export type DeadLetterJobRow = {
  id: string;
  job_id: string;
  reason: string;
  attempts: number;
  escalated_24h: boolean;
  escalated_72h: boolean;
  archived_at: string | null;
  created_at: string | Date;
  project_id: string;
  admin_contacts: string[] | null;
  project_name?: string | null;
  project_slug?: string | null;
  job_status?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
  tier?: string | null;
  godot_version?: string | null;
  max_attempts?: number | null;
};

/**
 * Consume a BullMQ `dead-letter` event: load job + project contacts,
 * enrich the operator payload, and email admin_contacts (ADMIN_EMAIL CC).
 */
export async function processDeadLetterEvent(
  data: { jobId: string; createdAt: number },
  deps: AlertMailDeps = {},
): Promise<{ notified: boolean; contacts: string[]; jobId: string }> {
  const { rows } = await getPool().query(
    `SELECT d.id, d.job_id, d.reason, d.attempts, d.escalated_24h, d.escalated_72h,
            d.archived_at, d.created_at,
            j.project_id, j.status AS job_status, j.error_code, j.error_detail,
            j.tier, j.godot_version, j.max_attempts,
            p.name AS project_name, p.slug AS project_slug, p.admin_contacts
     FROM dead_letter_jobs d
     JOIN jobs j ON j.id = d.job_id
     JOIN projects p ON p.id = j.project_id
     WHERE d.job_id = $1
     ORDER BY d.created_at DESC
     LIMIT 1`,
    [data.jobId],
  );

  if (rows.length === 0) {
    // Job may have been archived/deleted; still emit a minimal alert for operators.
    console.warn(
      `[dead-letter] no dead_letter_jobs row for ${data.jobId}; sending minimal alert`,
    );
    await sendAlert(
      {
        title: 'Dead-letter event (job row missing)',
        severity: 'high',
        body: `BullMQ dead-letter event for job ${data.jobId} at ${new Date(data.createdAt).toISOString()}, but no dead_letter_jobs/project row was found.`,
        code: 'E020',
        jobId: data.jobId,
      },
      deps,
    );
    return { notified: true, contacts: [], jobId: data.jobId };
  }

  const row = rows[0] as DeadLetterJobRow;
  const contacts = normalizeEmailList(row.admin_contacts ?? []);

  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at;

  const body = buildDeadLetterEnteredBody({
    jobId: row.job_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    status: row.job_status,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    reason: row.reason,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    tier: row.tier,
    godotVersion: row.godot_version,
    createdAt,
    contacts,
  });

  await sendAlert(
    {
      title: 'Job moved to dead-letter queue',
      severity: 'high',
      body,
      code: 'E020',
      jobId: row.job_id,
      projectId: row.project_id,
      to: contacts,
    },
    deps,
  );

  console.info(
    `[dead-letter] enriched notify job=${row.job_id} contacts=${contacts.length} project=${row.project_id}`,
  );

  return { notified: true, contacts, jobId: row.job_id };
}

/**
 * Hourly scan: 24h high + 72h critical escalations email project admin_contacts.
 */
export async function escalateUnresolvedDeadLetters(
  deps: AlertMailDeps = {},
  nowMs: number = Date.now(),
): Promise<{ escalated24: number; escalated72: number }> {
  const { rows } = await getPool().query(
    `SELECT d.*, j.project_id, j.error_code, j.error_detail, j.tier,
            p.admin_contacts, p.name AS project_name, p.slug AS project_slug
     FROM dead_letter_jobs d
     JOIN jobs j ON j.id = d.job_id
     JOIN projects p ON p.id = j.project_id
     WHERE d.archived_at IS NULL`,
  );

  let escalated24 = 0;
  let escalated72 = 0;

  for (const row of rows) {
    const ageH =
      (nowMs - new Date(row.created_at as string).getTime()) / 3_600_000;
    const contacts = normalizeEmailList(
      (row.admin_contacts as string[] | null) ?? [],
    );
    const detail = [
      `Job ${row.job_id} remains in dead-letter queue.`,
      `Project: ${row.project_name ?? row.project_id}${row.project_slug ? ` (${row.project_slug})` : ''}`,
      `Age: ${ageH.toFixed(1)}h`,
      `Reason: ${row.reason}`,
      `Error: ${row.error_code ?? 'E020'}${row.error_detail ? ` — ${row.error_detail}` : ''}`,
      `Attempts recorded: ${row.attempts}`,
      `Tier: ${row.tier ?? 'n/a'}`,
    ].join('\n');

    if (ageH >= 72 && !row.escalated_72h) {
      await escalateDeadLetter(row.job_id, 72, contacts, deps, {
        projectId: row.project_id as string,
        bodyDetail: detail,
      });
      await getPool().query(
        `UPDATE dead_letter_jobs SET escalated_72h = true WHERE id = $1`,
        [row.id],
      );
      escalated72 += 1;
    } else if (ageH >= 24 && !row.escalated_24h) {
      await escalateDeadLetter(row.job_id, 24, contacts, deps, {
        projectId: row.project_id as string,
        bodyDetail: detail,
      });
      await getPool().query(
        `UPDATE dead_letter_jobs SET escalated_24h = true WHERE id = $1`,
        [row.id],
      );
      escalated24 += 1;
    }
  }

  return { escalated24, escalated72 };
}
