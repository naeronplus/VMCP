import {
  ERROR_CATALOG,
  errorPayload,
  canTransitionJobStatus,
  isRetriableFailure,
  isTerminal,
  type CommitStrategy,
  type CreateJobRequest,
  type ErrorCode,
  type Job,
  type JobStatus,
  type JobStatusUpdate,
  type WorkerTier,
  type SecretEnvelope,
} from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool, withTransaction } from '../db/pool.js';
import { lockService } from './lock-service.js';
import { schedulerService } from './scheduler-service.js';
import { githubService } from './github-service.js';
import { secretService } from './secret-service.js';
import { s3Service } from './s3-service.js';
import { mintCallbackToken, hashToken } from './auth-service.js';
import {
  generateEphemeralEd25519,
  provisionPublicKey,
  resolveCrossMachineProvision,
} from './ssh-provision.js';
import { audit } from './audit-service.js';
import { sendAlert } from './alert-service.js';
import { getWsHub } from '../lib/ws-hub.js';
import { deadLetterQueue, dispatchQueue } from '../workers/queues.js';

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: row.status as JobStatus,
    tier: (row.tier as WorkerTier) ?? null,
    commitStrategy: row.commit_strategy as CommitStrategy,
    godotVersion: String(row.godot_version),
    fencingToken: (row.fencing_token as string) ?? null,
    lockKey: (row.lock_key as string) ?? null,
    githubRunId: row.github_run_id != null ? Number(row.github_run_id) : null,
    callbackTokenHash: (row.callback_token_hash as string) ?? null,
    callbackTokenExpiresAt: row.callback_token_expires_at
      ? new Date(row.callback_token_expires_at as string).toISOString()
      : null,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    blockedByJobId: row.blocked_by_job_id ? String(row.blocked_by_job_id) : null,
    dependsOnJobId: row.depends_on_job_id ? String(row.depends_on_job_id) : null,
    estimatedWaitSeconds:
      row.estimated_wait_seconds != null ? Number(row.estimated_wait_seconds) : null,
    s3StagingPrefix: (row.s3_staging_prefix as string) ?? null,
    s3ValidationReportKey: (row.s3_validation_report_key as string) ?? null,
    s3SnapshotKey: (row.s3_snapshot_key as string) ?? null,
    s3ArtifactsPrefix: (row.s3_artifacts_prefix as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    lastHeartbeatAt: row.last_heartbeat_at
      ? new Date(row.last_heartbeat_at as string).toISOString()
      : null,
    errorCode: (row.error_code as ErrorCode) ?? null,
    errorDetail: (row.error_detail as string) ?? null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at as string).toISOString()
      : null,
  };
}

/** created_by is UUID FK — only pass real user ids, never callback principals. */
function asUserUuid(id?: string | null): string | null {
  if (!id) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id;
}

export class JobService {
  async getById(id: string): Promise<Job | null> {
    const { rows } = await getPool().query(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async list(opts: { projectId?: string; status?: string; limit?: number }): Promise<Job[]> {
    const limit = opts.limit ?? 50;
    if (opts.projectId && opts.status) {
      const { rows } = await getPool().query(
        `SELECT * FROM jobs WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`,
        [opts.projectId, opts.status, limit],
      );
      return rows.map(mapJob);
    }
    if (opts.projectId) {
      const { rows } = await getPool().query(
        `SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [opts.projectId, limit],
      );
      return rows.map(mapJob);
    }
    const { rows } = await getPool().query(
      `SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(mapJob);
  }

  /**
   * Create generation job with project-level serialization (§7.1, §7.2).
   */
  async create(req: CreateJobRequest, createdBy?: string): Promise<Job> {
    const env = getEnv();
    const { rows: projects } = await getPool().query(
      `SELECT * FROM projects WHERE id = $1`,
      [req.projectId],
    );
    if (projects.length === 0) {
      throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    }
    const project = projects[0];
    const godotVersion = req.godotVersion ?? project.godot_version ?? env.GODOT_DEFAULT_VERSION;
    const commitStrategy: CommitStrategy = req.commitStrategy ?? 'same-machine';

    // Include retriable failures still mid-retry as active holders of the project slot
    const activeStatuses = [
      'QUEUED',
      'DISPATCHING',
      'STAGING',
      'VALIDATING',
      'VALIDATION_REPORT',
      'COMMITTING',
      'POST_COMMIT_VERIFY',
      'REIMPORT_FAILED',
      'VALIDATION_FAILED',
      'COMMIT_FAILED',
      'DISPATCH_TIMEOUT',
      'DISPATCH_FAILED',
    ];
    const { rows: activeJobs } = await getPool().query(
      `SELECT id, status FROM jobs
       WHERE project_id = $1 AND status = ANY($2::text[])
       ORDER BY created_at ASC LIMIT 1`,
      [req.projectId, activeStatuses],
    );

    const blocked = activeJobs.length > 0;
    const blockedBy = blocked ? activeJobs[0].id : null;
    const status: JobStatus = blocked ? 'BLOCKED' : 'QUEUED';
    const estimatedWait = blocked ? 120 : 0;

    const { rows } = await getPool().query(
      `INSERT INTO jobs (
         project_id, status, commit_strategy, godot_version,
         blocked_by_job_id, depends_on_job_id, estimated_wait_seconds,
         metadata, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.projectId,
        status,
        commitStrategy,
        godotVersion,
        blockedBy,
        req.dependsOnJobId ?? null,
        estimatedWait,
        JSON.stringify(req.metadata ?? {}),
        asUserUuid(createdBy),
      ],
    );

    const job = mapJob(rows[0]);
    await audit({
      actorId: asUserUuid(createdBy),
      action: 'job.created',
      resourceType: 'job',
      resourceId: job.id,
      detail: { status, blockedBy, preferredTier: req.preferredTier },
    });

    if (!blocked) {
      await this.dispatchJob(job.id, req.preferredTier);
    } else {
      getWsHub()?.broadcast({
        type: 'job.updated',
        payload: job,
        at: new Date().toISOString(),
      });
    }

    return (await this.getById(job.id))!;
  }

  async dispatchJob(jobId: string, preferredTier?: WorkerTier): Promise<void> {
    const job = await this.getById(jobId);
    if (!job) throw new Error('Job not found');
    if (
      job.status !== 'QUEUED' &&
      job.status !== 'LOCK_STALE' &&
      job.status !== 'DISPATCH_TIMEOUT' &&
      job.status !== 'DISPATCH_FAILED'
    ) {
      return;
    }

    const { rows: projects } = await getPool().query(
      `SELECT * FROM projects WHERE id = $1`,
      [job.projectId],
    );
    if (!projects[0]) throw new Error('Project missing for job');
    const project = projects[0];

    const tier = await schedulerService.selectTier({
      preferredTier,
      projectHighVolume: Boolean(project.high_volume),
    });

    const ownerId = `job:${jobId}`;
    const lockKey = lockService.generationLockKey(job.projectId);
    const acquire = await lockService.acquire(lockKey, ownerId, 120, { jobId });
    if (acquire.status === 'denied') {
      // Do not use updateStatus with BLOCKED if that would recurse weirdly —
      // write directly; BLOCKED is not a retriable failure.
      await getPool().query(
        `UPDATE jobs SET status = 'BLOCKED',
           metadata = metadata || $2::jsonb,
           updated_at = now()
         WHERE id = $1`,
        [jobId, JSON.stringify({ reason: 'generation_lock_held' })],
      );
      return;
    }
    if (acquire.status === 'error') {
      throw new Error(acquire.message);
    }

    let targetPathLockKey: string | undefined;
    if (job.commitStrategy === 'cross-machine') {
      targetPathLockKey = lockService.targetPathLockKey(job.projectId);
      const targetAcquire = await lockService.acquire(targetPathLockKey, ownerId, 120, {
        jobId,
      });
      if (targetAcquire.status === 'denied' || targetAcquire.status === 'error') {
        await lockService.release(lockKey, ownerId);
        await getPool().query(
          `UPDATE jobs SET status = 'BLOCKED',
             metadata = metadata || $2::jsonb,
             updated_at = now()
           WHERE id = $1`,
          [
            jobId,
            JSON.stringify({
              reason: 'target_path_lock_held',
              targetPathLockKey,
            }),
          ],
        );
        return;
      }
    }

    const cb = mintCallbackToken(jobId);
    const stagingKey = s3Service.stagingKey(job.projectId, jobId);
    const snapshotKey = s3Service.snapshotKey(job.projectId, jobId);
    const validationKey = s3Service.validationReportKey(job.projectId, jobId);
    const diagnosticsKey = s3Service.diagnosticsKey(
      job.projectId,
      jobId,
      'bundle.log',
    );

    const envelopeBase: Omit<SecretEnvelope, 'expiresAt'> = {
      callbackToken: cb.token,
      fencingToken: acquire.token,
      lockKey,
      lockOwner: ownerId,
      targetProjectRoot: String(project.project_root ?? `/var/godot/projects/${job.projectId}`),
      presignedUrls: {
        stagingPut: await s3Service.presignPut(stagingKey),
        stagingGet: await s3Service.presignGet(stagingKey),
        stagingArchivePut: await s3Service.presignPut(`${stagingKey}.tar.gz`),
        validationPut: await s3Service.presignPut(validationKey),
        snapshotPut: await s3Service.presignPut(snapshotKey),
        snapshotGet: await s3Service.presignGet(snapshotKey),
        diagnosticsPut: await s3Service.presignPut(diagnosticsKey),
      },
    };

    const cross = resolveCrossMachineProvision(job.commitStrategy, job.metadata);
    if (cross.action === 'fail') {
      await this.failDispatchPreStart({
        jobId,
        lockKey,
        ownerId,
        targetPathLockKey,
        detail: cross.detail,
      });
      return;
    }
    if (cross.action === 'provision') {
      const ssh = generateEphemeralEd25519();
      const forcedCommand = 'commit-agent-once';
      const provision = await provisionPublicKey({
        targetProvisionUrl: cross.provisionUrl,
        publicKeyOpenSsh: ssh.publicKeyOpenSsh,
        forcedCommand,
        jobId,
        environment: {
          PGOS_LOCK_KEY: lockKey,
          PGOS_LOCK_OWNER: ownerId,
          PGOS_JOB_ID: jobId,
          PGOS_REQUIRE_FENCING: 'true',
        },
        maxSessions: 8,
        ttlSeconds: 300,
      });
      if (!provision.ok) {
        await this.failDispatchPreStart({
          jobId,
          lockKey,
          ownerId,
          targetPathLockKey,
          detail: `ssh provision failed: ${provision.detail ?? 'unknown'}`,
        });
        return;
      }
      envelopeBase.targetHost = cross.targetHost;
      envelopeBase.sshPrivateKey = ssh.privateKeyPem;
      envelopeBase.sshKeyId = ssh.keyId;
    }

    const { jwe } = await secretService.createEnvelope(jobId, envelopeBase);

    const dispatchMeta = targetPathLockKey
      ? { targetPathLockKey }
      : {};
    await getPool().query(
      `UPDATE jobs SET
         status = 'DISPATCHING',
         tier = $2,
         fencing_token = $3,
         lock_key = $4,
         callback_token_hash = $5,
         callback_token_expires_at = $6,
         metadata = metadata || $7::jsonb,
         updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        tier,
        acquire.token,
        lockKey,
        cb.hash,
        cb.expiresAt.toISOString(),
        JSON.stringify(dispatchMeta),
      ],
    );

    try {
      await githubService.dispatchWorkflow({
        jobId,
        projectId: job.projectId,
        godotVersion: job.godotVersion,
        commitStrategy: job.commitStrategy,
        tier,
        secretJwe: jwe,
      });
    } catch (err) {
      await this.recordError(jobId, 'E001', `Dispatch failed: ${(err as Error).message}`);
      // Keep lock until handleFailure decides retry vs dead-letter
      await this.updateStatus(jobId, {
        status: 'DISPATCH_TIMEOUT',
        errorCode: 'E001',
        errorDetail: (err as Error).message,
      });
      return;
    }

    await dispatchQueue.add(
      'resolve-run',
      { jobId, tier, attempt: job.attempt },
      {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
        jobId: `resolve-${jobId}-${job.attempt}`,
      },
    );

    await schedulerService.enqueuePriority(jobId, Date.now());
    const updated = await this.getById(jobId);
    getWsHub()?.broadcast({
      type: 'job.updated',
      payload: updated,
      at: new Date().toISOString(),
    });
  }

  /**
   * Provision / pre-dispatch failure: release acquired locks, never embed SSH material,
   * mark DISPATCH_FAILED (retriable). Must run before JWE creation / workflow dispatch.
   */
  private async failDispatchPreStart(opts: {
    jobId: string;
    lockKey: string;
    ownerId: string;
    targetPathLockKey?: string;
    detail: string;
  }): Promise<void> {
    await lockService.release(opts.lockKey, opts.ownerId);
    if (opts.targetPathLockKey) {
      await lockService.release(opts.targetPathLockKey, opts.ownerId);
    }
    // Job is still QUEUED/LOCK_STALE/DISPATCH_* when provision runs (before DISPATCHING).
    // updateStatus records E004 and runs handleFailure (retriable → requeue / dead-letter).
    await this.updateStatus(opts.jobId, {
      status: 'DISPATCH_FAILED',
      errorCode: 'E004',
      errorDetail: opts.detail,
    });
  }

  async verifyCallbackToken(jobId: string, token: string): Promise<boolean> {
    const job = await this.getById(jobId);
    if (!job || !job.callbackTokenHash || !job.callbackTokenExpiresAt) return false;
    if (new Date(job.callbackTokenExpiresAt) < new Date()) return false;
    return hashToken(token) === job.callbackTokenHash;
  }

  async updateStatus(
    jobId: string,
    update: JobStatusUpdate,
    opts?: { fromCallback?: boolean; skipFailureHandler?: boolean },
  ): Promise<Job> {
    const current = await this.getById(jobId);
    if (!current) throw new Error('Job not found');

    if (
      update.status !== current.status &&
      !canTransitionJobStatus(current.status, update.status)
    ) {
      throw Object.assign(
        new Error(`Invalid status transition ${current.status} → ${update.status}`),
        { statusCode: 409, code: 'E019' },
      );
    }

    // Prevent commits after REIMPORT_FAILED (§4.1 step 3) — even mid-retry window
    // until a fresh dispatch starts a new attempt cycle
    if (
      current.status === 'REIMPORT_FAILED' &&
      (update.status === 'COMMITTING' || update.status === 'COMPLETED')
    ) {
      throw Object.assign(new Error('Commits blocked after REIMPORT_FAILED'), {
        statusCode: 409,
      });
    }

    if (update.fencingToken && current.lockKey) {
      const ok = await lockService.validateFencingToken(
        current.lockKey,
        `job:${jobId}`,
        update.fencingToken,
      );
      if (!ok) {
        await this.recordError(jobId, 'E013', 'Fencing token rejected');
        throw Object.assign(new Error('Fencing token rejected'), {
          statusCode: 403,
          code: 'E013',
        });
      }
    }

    const sets: string[] = ['status = $2', 'updated_at = now()'];
    const params: unknown[] = [jobId, update.status];
    let i = 3;

    if (update.metadata) {
      sets.push(`metadata = metadata || $${i}::jsonb`);
      params.push(JSON.stringify(update.metadata));
      i++;
    }
    if (update.errorCode) {
      sets.push(`error_code = $${i}`);
      params.push(update.errorCode);
      i++;
    }
    if (update.errorDetail) {
      sets.push(`error_detail = $${i}`);
      params.push(update.errorDetail);
      i++;
    }
    if (update.s3StagingPrefix) {
      sets.push(`s3_staging_prefix = $${i}`);
      params.push(update.s3StagingPrefix);
      i++;
    }
    if (update.s3ValidationReportKey) {
      sets.push(`s3_validation_report_key = $${i}`);
      params.push(update.s3ValidationReportKey);
      i++;
    }
    if (update.s3SnapshotKey) {
      sets.push(`s3_snapshot_key = $${i}`);
      params.push(update.s3SnapshotKey);
      i++;
    }
    if (update.s3ArtifactsPrefix) {
      sets.push(`s3_artifacts_prefix = $${i}`);
      params.push(update.s3ArtifactsPrefix);
      i++;
    }
    if (update.githubRunId != null) {
      sets.push(`github_run_id = $${i}`);
      params.push(update.githubRunId);
      i++;
    }
    if (isTerminal(update.status)) {
      sets.push(`completed_at = now()`);
    }
    if (
      update.status === 'STAGING' ||
      update.status === 'VALIDATING' ||
      update.status === 'COMMITTING' ||
      update.status === 'DISPATCHING'
    ) {
      sets.push(`last_heartbeat_at = now()`);
    }

    await getPool().query(
      `UPDATE jobs SET ${sets.join(', ')} WHERE id = $1`,
      params,
    );

    if (update.errorCode) {
      await this.recordError(jobId, update.errorCode, update.errorDetail ?? update.errorCode);
    }

    // Retriable failures: keep lock, retry via handleFailure — do NOT promote blocked jobs
    if (isRetriableFailure(update.status) && !opts?.skipFailureHandler) {
      await this.handleFailure(jobId);
    } else if (isTerminal(update.status) && current.lockKey) {
      // Final terminal (COMPLETED, ROLLBACK, DEAD_LETTER, DEP_FAILED, CANCELLED)
      await lockService.release(current.lockKey, `job:${jobId}`);
      const targetLock = current.metadata?.targetPathLockKey as string | undefined;
      if (targetLock) {
        await lockService.release(targetLock, `job:${jobId}`);
      }
      await this.promoteBlockedJobs(current.projectId, jobId, update.status);
    }

    if (update.status === 'ROLLBACK') {
      await sendAlert({
        title: 'Job rolled back after post-commit reimport failure',
        severity: 'high',
        body: `Job ${jobId} rolled back from S3 snapshot`,
        code: 'E002',
        jobId,
        projectId: current.projectId,
      });
    }

    const job = (await this.getById(jobId))!;
    getWsHub()?.broadcast({
      type: 'job.updated',
      payload: job,
      at: new Date().toISOString(),
    });
    void opts?.fromCallback;
    return job;
  }

  async heartbeat(
    jobId: string,
    fencingToken?: string,
  ): Promise<{ ok: boolean }> {
    const job = await this.getById(jobId);
    if (!job) return { ok: false };
    if (fencingToken && job.lockKey) {
      const ok = await lockService.validateFencingToken(
        job.lockKey,
        `job:${jobId}`,
        fencingToken,
      );
      if (!ok) return { ok: false };
    }
    await getPool().query(
      `UPDATE jobs SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`,
      [jobId],
    );
    if (job.lockKey) {
      await getPool().query(
        `UPDATE pg_locks SET last_heartbeat_at = now() WHERE lock_key = $1`,
        [job.lockKey],
      );
      const redis = (await import('../lib/redis.js')).getRedis();
      await redis.expire(job.lockKey, 60);
      await redis.expire(`lock_fencing_token:${job.lockKey}`, 60);
    }
    return { ok: true };
  }

  async recordError(
    jobId: string,
    code: ErrorCode,
    detail: string,
    artifactsS3Key?: string,
  ): Promise<void> {
    const def = ERROR_CATALOG[code];
    if (!def) return;
    await getPool().query(
      `INSERT INTO job_errors (job_id, code, class, severity, detail, artifacts_s3_key)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [jobId, def.code, def.class, def.severity, detail, artifactsS3Key ?? null],
    );
    getWsHub()?.broadcast({
      type: 'job.error',
      payload: errorPayload(code, detail),
      at: new Date().toISOString(),
    });
  }

  /**
   * Retry up to maxAttempts, then dead-letter.
   * Holds generation lock across retries; releases only on dead-letter.
   */
  private async handleFailure(jobId: string): Promise<void> {
    const job = await this.getById(jobId);
    if (!job) return;

    if (job.attempt < job.maxAttempts) {
      const nextAttempt = job.attempt + 1;
      const otherTier: WorkerTier | undefined =
        job.status === 'DISPATCH_TIMEOUT' && job.tier
          ? job.tier === 'A'
            ? 'B'
            : 'A'
          : (job.tier ?? undefined);

      await getPool().query(
        `UPDATE jobs SET attempt = $2, status = 'QUEUED', updated_at = now(),
           completed_at = NULL
         WHERE id = $1`,
        [jobId, nextAttempt],
      );
      await this.dispatchJob(jobId, otherTier);
      return;
    }

    // Exhausted retries → dead-letter (§8.2)
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE jobs SET status = 'DEAD_LETTER', error_code = 'E020',
           updated_at = now(), completed_at = now()
         WHERE id = $1`,
        [jobId],
      );
      await client.query(
        `INSERT INTO dead_letter_jobs (job_id, reason, attempts)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_id) DO UPDATE SET attempts = EXCLUDED.attempts, archived_at = NULL`,
        [jobId, job.errorDetail ?? job.status, job.attempt],
      );
    });

    if (job.lockKey) {
      await lockService.release(job.lockKey, `job:${jobId}`);
      await this.promoteBlockedJobs(job.projectId, jobId, 'DEAD_LETTER');
    }

    await deadLetterQueue.add(
      'dead-letter',
      { jobId, createdAt: Date.now() },
      { jobId: `dlq-${jobId}`, removeOnComplete: false },
    );

    await sendAlert({
      title: 'Job moved to dead-letter queue',
      severity: 'high',
      body: `Job ${jobId} failed ${job.attempt} times`,
      code: 'E020',
      jobId,
      projectId: job.projectId,
    });

    getWsHub()?.broadcast({
      type: 'job.updated',
      payload: await this.getById(jobId),
      at: new Date().toISOString(),
    });
  }

  /**
   * When active job finishes, dispatch blocked jobs or mark DEP_FAILED (§7.2).
   */
  private async promoteBlockedJobs(
    projectId: string,
    finishedJobId: string,
    finishedStatus: JobStatus,
  ): Promise<void> {
    const { rows } = await getPool().query(
      `SELECT * FROM jobs WHERE project_id = $1 AND status = 'BLOCKED'
       ORDER BY created_at ASC`,
      [projectId],
    );

    for (const row of rows) {
      const job = mapJob(row);
      if (job.blockedByJobId && job.blockedByJobId !== finishedJobId) {
        continue;
      }
      if (
        job.dependsOnJobId === finishedJobId &&
        finishedStatus !== 'COMPLETED'
      ) {
        await this.updateStatus(job.id, {
          status: 'DEP_FAILED',
          errorCode: 'E011',
          errorDetail: `Dependency job ${finishedJobId} ended with ${finishedStatus}`,
        });
        continue;
      }
      await getPool().query(
        `UPDATE jobs SET status = 'QUEUED', blocked_by_job_id = NULL,
           estimated_wait_seconds = 0, updated_at = now()
         WHERE id = $1`,
        [job.id],
      );
      await this.dispatchJob(job.id);
      break;
    }
  }

  /**
   * After admin reclaim: clear stale lock fields and redispatch if attempts remain.
   */
  async handleAdminReclaim(lockKey: string, reason: string): Promise<void> {
    const { rows: jobs } = await getPool().query(
      `SELECT id, attempt, max_attempts FROM jobs
       WHERE lock_key = $1 AND completed_at IS NULL`,
      [lockKey],
    );

    for (const row of jobs) {
      const jobId = String(row.id);
      await getPool().query(
        `UPDATE jobs SET
           status = 'LOCK_STALE',
           lock_key = NULL,
           fencing_token = NULL,
           error_code = 'E005',
           error_detail = $2,
           updated_at = now()
         WHERE id = $1`,
        [jobId, `Admin reclaim: ${reason}`],
      );
      await this.recordError(jobId, 'E005', `Admin reclaim: ${reason}`);

      if (Number(row.attempt) < Number(row.max_attempts)) {
        await getPool().query(
          `UPDATE jobs SET status = 'QUEUED', attempt = attempt + 1, updated_at = now()
           WHERE id = $1`,
          [jobId],
        );
        await this.dispatchJob(jobId);
      } else {
        await this.updateStatus(jobId, {
          status: 'DEAD_LETTER',
          errorCode: 'E020',
          errorDetail: 'Exhausted attempts after admin reclaim',
        });
      }
    }
  }

  async searchErrors(q: string, limit = 50): Promise<unknown[]> {
    if (!q.trim()) {
      const { rows } = await getPool().query(
        `SELECT * FROM job_errors ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    }
    const { rows } = await getPool().query(
      `SELECT * FROM job_errors
       WHERE to_tsvector('english', coalesce(detail,'') || ' ' || coalesce(class,'') || ' ' || coalesce(code,''))
             @@ plainto_tsquery('english', $1)
       ORDER BY created_at DESC LIMIT $2`,
      [q, limit],
    );
    return rows;
  }

  async listDeadLetter(): Promise<unknown[]> {
    const { rows } = await getPool().query(
      `SELECT d.*, j.status, j.project_id, j.error_detail
       FROM dead_letter_jobs d
       JOIN jobs j ON j.id = d.job_id
       WHERE d.archived_at IS NULL
       ORDER BY d.created_at DESC`,
    );
    return rows;
  }

  async retryDeadLetter(jobId: string): Promise<Job> {
    await getPool().query(
      `UPDATE dead_letter_jobs SET archived_at = now() WHERE job_id = $1`,
      [jobId],
    );
    await getPool().query(
      `UPDATE jobs SET status = 'QUEUED', attempt = 1, error_code = NULL, error_detail = NULL,
         completed_at = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId],
    );
    await this.dispatchJob(jobId);
    return (await this.getById(jobId))!;
  }
}

export const jobService = new JobService();
