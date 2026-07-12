/**
 * H-02: Consume merge_outbox pending rows.
 * - Local readable project_root → applyTscnToFilesystem
 * - Remote → dispatch merge_apply.yml (Tier A) with patch in S3
 *
 * Pure process* helpers are importable without BullMQ/env (tests).
 * startMergeOutboxWorker() is the only entry that loads queues.
 */
import { getPool } from '../db/pool.js';
import { audit } from '../services/audit-service.js';
import { sendAlert } from '../services/alert-service.js';
import {
  applyTscnToFilesystem,
  pathIsReadableDir,
} from '../services/merge-apply.js';
import type { TscnPatch } from '../services/tscn-merge.js';
import { s3Service } from '../services/s3-service.js';
import { githubService } from '../services/github-service.js';
import {
  buildMergeApplyDispatchEnvelope,
  type MergeApplyDispatchEnvelope,
} from '../services/merge-outbox-dispatch.js';

export const MERGE_APPLY_WORKFLOW = 'merge_apply.yml';

export type MergeOutboxPendingRow = {
  id: string;
  override_id: string;
  project_id: string;
  path: string;
  project_root: string | null;
  patch: unknown;
  metadata: Record<string, unknown> | null;
  introduces_script: boolean;
};

export type ProcessMergeOutboxResult = {
  applied: number;
  failed: number;
  dispatched: number;
  skipped: number;
};

export type MergeOutboxDeps = {
  listPending: (limit: number) => Promise<MergeOutboxPendingRow[]>;
  markApplied: (opts: {
    outboxId: string;
    overrideId: string;
    mergedHash: string;
  }) => Promise<void>;
  markFailed: (outboxId: string, detail: string) => Promise<void>;
  markDispatched: (outboxId: string, detail: string) => Promise<void>;
  pathIsReadableDir: (dir: string) => Promise<boolean>;
  applyTscn: typeof applyTscnToFilesystem;
  putPatchObject: (key: string, body: string) => Promise<void>;
  presignGet: (key: string, expiresIn?: number) => Promise<string>;
  dispatchMergeApply: (inputs: Record<string, string>) => Promise<{
    dispatched: boolean;
    mock?: boolean;
  }>;
  /** H-02: build secretJwe envelope for remote dispatch (injectable for tests). */
  buildDispatchEnvelope?: (opts: {
    row: MergeOutboxPendingRow;
    projectRoot: string;
    patchGetUrl: string;
    s3Key: string;
  }) => Promise<MergeApplyDispatchEnvelope>;
  audit: typeof audit;
  sendAlert: typeof sendAlert;
  now?: () => Date;
};

function asPatch(raw: unknown): TscnPatch {
  if (raw && typeof raw === 'object') return raw as TscnPatch;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TscnPatch;
    } catch {
      return {};
    }
  }
  return {};
}

function projectMeta(row: MergeOutboxPendingRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

/** True when project is expected on a remote host (no local tree for consumer). */
export function isRemoteMergeTarget(
  projectRoot: string | null | undefined,
  metadata: Record<string, unknown>,
  rootReadable: boolean,
): boolean {
  if (rootReadable) return false;
  const host = metadata.targetHost ?? metadata.target_host;
  return Boolean(host) || Boolean(projectRoot);
}

export async function processMergeOutboxRow(
  row: MergeOutboxPendingRow,
  deps: MergeOutboxDeps,
): Promise<'applied' | 'failed' | 'dispatched' | 'skipped'> {
  const patch = asPatch(row.patch);
  const root = row.project_root ? String(row.project_root) : '';
  const meta = projectMeta(row);

  if (!row.path.endsWith('.tscn')) {
    await deps.markFailed(
      row.id,
      `unsupported path for structural merge: ${row.path}`,
    );
    await deps.sendAlert({
      title: 'Merge outbox failed',
      severity: 'medium',
      body: `outbox=${row.id} path=${row.path} (not .tscn)`,
      code: 'E014',
      projectId: row.project_id,
    });
    return 'failed';
  }

  const readable = root ? await deps.pathIsReadableDir(root) : false;

  if (readable) {
    try {
      const applied = await deps.applyTscn(root, row.path, patch);
      await deps.markApplied({
        outboxId: row.id,
        overrideId: row.override_id,
        mergedHash: applied.mergedHash,
      });
      await deps.audit({
        action: 'merge.outbox_applied',
        resourceType: 'merge_outbox',
        resourceId: row.id,
        detail: {
          overrideId: row.override_id,
          projectId: row.project_id,
          path: row.path,
          applyMode: 'local_fs',
          mergedHash: applied.mergedHash,
        },
      });
      return 'applied';
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const code =
        (err as { code?: string }).code === 'E019' ? 'E019' : 'E014';
      await deps.markFailed(row.id, detail);
      await deps.sendAlert({
        title: 'Merge outbox apply failed',
        severity: code === 'E019' ? 'high' : 'medium',
        body: `outbox=${row.id} path=${row.path}: ${detail}`,
        code,
        projectId: row.project_id,
      });
      await deps.audit({
        action: 'merge.outbox_failed',
        resourceType: 'merge_outbox',
        resourceId: row.id,
        detail: { path: row.path, detail, code },
      });
      return 'failed';
    }
  }

  // Remote / unreadable: dispatch workflow for host-side apply
  if (!isRemoteMergeTarget(root, meta, readable) && !root) {
    await deps.markFailed(
      row.id,
      'no project_root and no local tree — cannot apply merge',
    );
    await deps.sendAlert({
      title: 'Merge outbox failed',
      severity: 'medium',
      body: `outbox=${row.id}: missing project_root`,
      code: 'E014',
      projectId: row.project_id,
    });
    return 'failed';
  }

  try {
    const s3Key = `projects/${row.project_id}/merge-outbox/${row.id}/patch.json`;
    await deps.putPatchObject(s3Key, JSON.stringify(patch));
    const patchGetUrl = await deps.presignGet(s3Key, 3600);
    const projectRoot =
      root ||
      String(meta.projectRoot ?? meta.project_root ?? `/var/godot/projects/${row.project_id}`);

    // H-02: seal SSH / service token in secretJwe — never as bare workflow inputs.
    const buildEnvelope =
      deps.buildDispatchEnvelope ??
      ((o) => buildMergeApplyDispatchEnvelope(o));
    const envelope = await buildEnvelope({
      row,
      projectRoot,
      patchGetUrl,
      s3Key,
    });
    const inputs = envelope.workflowInputs;
    if (!inputs.secretJwe) {
      throw new Error('merge-apply dispatch envelope missing secretJwe');
    }
    for (const [k, v] of Object.entries(inputs)) {
      if (k !== 'secretJwe' && /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/i.test(v)) {
        throw new Error(`refusing dispatch: private key leaked in input ${k}`);
      }
    }

    await deps.dispatchMergeApply(inputs);

    // Leave status pending until host callback marks applied; record dispatch in detail.
    await deps.markDispatched(
      row.id,
      `dispatched ${MERGE_APPLY_WORKFLOW} s3Key=${s3Key} secretJwe=1`,
    );
    await deps.audit({
      action: 'merge.outbox_dispatched',
      resourceType: 'merge_outbox',
      resourceId: row.id,
      detail: {
        workflow: MERGE_APPLY_WORKFLOW,
        s3Key,
        path: row.path,
        projectRoot,
        secretJwe: true,
        targetHost: envelope.sealed.targetHost ?? null,
        hasSshPrivateKey: envelope.sealed.hasSshPrivateKey,
      },
    });
    return 'dispatched';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await deps.markFailed(row.id, `dispatch failed: ${detail}`);
    await deps.sendAlert({
      title: 'Merge outbox remote dispatch failed',
      severity: 'high',
      body: `outbox=${row.id}: ${detail}`,
      code: 'E014',
      projectId: row.project_id,
    });
    return 'failed';
  }
}

export function createDefaultMergeOutboxDeps(): MergeOutboxDeps {
  return {
    async listPending(limit) {
      const { rows } = await getPool().query(
        `SELECT o.id, o.override_id, o.project_id, o.path,
                p.project_root, p.metadata, ov.patch, ov.introduces_script
         FROM merge_outbox o
         JOIN projects p ON p.id = o.project_id
         JOIN overrides ov ON ov.id = o.override_id
         WHERE o.status = 'pending'
         ORDER BY o.created_at ASC
         LIMIT $1
         FOR UPDATE OF o SKIP LOCKED`,
        [limit],
      );
      return rows.map((r) => ({
        id: String(r.id),
        override_id: String(r.override_id),
        project_id: String(r.project_id),
        path: String(r.path),
        project_root: r.project_root != null ? String(r.project_root) : null,
        patch: r.patch,
        metadata:
          r.metadata && typeof r.metadata === 'object'
            ? (r.metadata as Record<string, unknown>)
            : {},
        introduces_script: Boolean(r.introduces_script),
      }));
    },
    async markApplied({ outboxId, overrideId, mergedHash }) {
      const pool = getPool();
      await pool.query(
        `UPDATE merge_outbox
         SET status = 'applied', applied_at = now(), detail = NULL
         WHERE id = $1`,
        [outboxId],
      );
      await pool.query(
        `UPDATE overrides
         SET merged_hash = $1, apply_mode = 'outbox'
         WHERE id = $2`,
        [mergedHash, overrideId],
      );
    },
    async markFailed(outboxId, detail) {
      await getPool().query(
        `UPDATE merge_outbox
         SET status = 'failed', detail = $2
         WHERE id = $1`,
        [outboxId, detail.slice(0, 2000)],
      );
    },
    async markDispatched(outboxId, detail) {
      // Stay pending so re-dispatch is possible after host failure; stamp detail.
      // Host-side merge-apply.sh should call API to mark applied when available.
      // For v2.0 without callback route: store detail and leave pending;
      // a second consumer pass skips if detail starts with "dispatched" only when
      // PGOS_MERGE_OUTBOX_REDISPATCH=0.
      const redispatch =
        process.env.PGOS_MERGE_OUTBOX_REDISPATCH === '1';
      if (!redispatch) {
        await getPool().query(
          `UPDATE merge_outbox
           SET detail = $2
           WHERE id = $1 AND status = 'pending'`,
          [outboxId, detail.slice(0, 2000)],
        );
      } else {
        await getPool().query(
          `UPDATE merge_outbox SET detail = $2 WHERE id = $1`,
          [outboxId, detail.slice(0, 2000)],
        );
      }
    },
    pathIsReadableDir,
    applyTscn: applyTscnToFilesystem,
    async putPatchObject(key, body) {
      await s3Service.putObject(key, body, 'application/json');
    },
    async presignGet(key, expiresIn = 3600) {
      return s3Service.presignGet(key, expiresIn);
    },
    async dispatchMergeApply(inputs) {
      return githubService.dispatchWorkflowFile(MERGE_APPLY_WORKFLOW, inputs);
    },
    buildDispatchEnvelope: (o) => buildMergeApplyDispatchEnvelope(o),
    audit,
    sendAlert,
  };
}

export async function processPendingMergeOutbox(
  deps: MergeOutboxDeps = createDefaultMergeOutboxDeps(),
  limit = 10,
): Promise<ProcessMergeOutboxResult> {
  const rows = await deps.listPending(limit);
  const result: ProcessMergeOutboxResult = {
    applied: 0,
    failed: 0,
    dispatched: 0,
    skipped: 0,
  };

  for (const row of rows) {
    const outcome = await processMergeOutboxRow(row, deps);
    if (outcome === 'applied') result.applied++;
    else if (outcome === 'failed') result.failed++;
    else if (outcome === 'dispatched') result.dispatched++;
    else result.skipped++;
  }
  return result;
}

/** Production deps that skip already-dispatched pending rows (detail prefix). */
export function createDefaultMergeOutboxDepsWithDispatchGuard(): MergeOutboxDeps {
  const base = createDefaultMergeOutboxDeps();
  return {
    ...base,
    async listPending(limit) {
      const { rows } = await getPool().query(
        `SELECT o.id, o.override_id, o.project_id, o.path, o.detail,
                p.project_root, p.metadata, ov.patch, ov.introduces_script
         FROM merge_outbox o
         JOIN projects p ON p.id = o.project_id
         JOIN overrides ov ON ov.id = o.override_id
         WHERE o.status = 'pending'
           AND (
             $2::boolean
             OR o.detail IS NULL
             OR o.detail NOT LIKE 'dispatched %'
           )
         ORDER BY o.created_at ASC
         LIMIT $1
         FOR UPDATE OF o SKIP LOCKED`,
        [limit, process.env.PGOS_MERGE_OUTBOX_REDISPATCH === '1'],
      );
      return rows.map((r) => ({
        id: String(r.id),
        override_id: String(r.override_id),
        project_id: String(r.project_id),
        path: String(r.path),
        project_root: r.project_root != null ? String(r.project_root) : null,
        patch: r.patch,
        metadata:
          r.metadata && typeof r.metadata === 'object'
            ? (r.metadata as Record<string, unknown>)
            : {},
        introduces_script: Boolean(r.introduces_script),
      }));
    },
  };
}

export async function runMergeOutboxDrain(): Promise<ProcessMergeOutboxResult> {
  return processPendingMergeOutbox(
    createDefaultMergeOutboxDepsWithDispatchGuard(),
    10,
  );
}

export async function startMergeOutboxWorker(): Promise<
  import('bullmq').Worker
> {
  const bullmq = await import('bullmq');
  const { queueConnection } = await import('./queues.js');
  return new bullmq.Worker(
    'pgos-merge-outbox',
    async (job: import('bullmq').Job) => {
      if (job.name === 'drain-pending') {
        const result = await runMergeOutboxDrain();
        await getPool().query(
          `INSERT INTO cron_heartbeats (name, last_beat_at) VALUES ($1, now())
           ON CONFLICT (name) DO UPDATE SET last_beat_at = now()`,
          ['merge-outbox-drain'],
        );
        return result;
      }
    },
    { connection: queueConnection() },
  );
}
