import { Worker, type Job } from 'bullmq';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { lockService } from '../services/lock-service.js';
import { jobService } from '../services/job-service.js';
import { sendAlert } from '../services/alert-service.js';
import {
  escalateUnresolvedDeadLetters,
  processDeadLetterEvent,
} from '../services/dead-letter-service.js';
import { schedulerService } from '../services/scheduler-service.js';
import { uidService } from '../services/uid-service.js';
import { githubService } from '../services/github-service.js';
import {
  queueConnection,
  healthQueue,
  secretRotationQueue,
  parityQueue,
  mergeOutboxQueue,
} from './queues.js';
import { getRedis, REDIS_INSTANCE_KEY } from '../lib/redis.js';
import { startMergeOutboxWorker } from './merge-outbox-worker.js';

/**
 * Dual-path health checker (§3.2):
 * - Railway-side BullMQ repeatable job every 15s for stale locks
 * - GitHub scheduled workflow is external (workers/godot_health.yml)
 */
export async function startHealthWorkers(): Promise<Worker[]> {
  const workers: Worker[] = [];

  const healthWorker = new Worker(
    'pgos-health',
    async (job: Job) => {
      if (job.name === 'stale-lock-scan') {
        await scanStaleLocks();
        await beat('railway-stale-lock-scan');
      } else if (job.name === 'dead-letter-escalate') {
        await escalateDeadLetters();
      } else if (job.name === 'redis-failover-check') {
        await checkRedisFailover();
      } else if (job.name === 'tier-b-probe') {
        await probeTierB();
      }
    },
    { connection: queueConnection() },
  );
  workers.push(healthWorker);

  const dispatchWorker = new Worker(
    'pgos-dispatch',
    async (job: Job) => {
      if (job.name === 'resolve-run') {
        await resolveDispatch(job.data as {
          jobId: string;
          tier: 'A' | 'B';
          attempt: number;
        });
      }
    },
    { connection: queueConnection() },
  );
  workers.push(dispatchWorker);

  const uidWorker = new Worker(
    'pgos-uid-reconcile',
    async (job: Job) => {
      if (job.name === 'nightly-reconcile') {
        await nightlyUidReconcile();
      }
    },
    { connection: queueConnection() },
  );
  workers.push(uidWorker);

  const deadLetterWorker = new Worker(
    'pgos-dead-letter',
    async (job: Job) => {
      if (job.name === 'dead-letter') {
        // H-14: load job + admin_contacts, enrich, email contacts (not a stub)
        const data = job.data as { jobId: string; createdAt: number };
        await processDeadLetterEvent(data);
        await beat('dead-letter-consumer');
      }
    },
    { connection: queueConnection() },
  );
  workers.push(deadLetterWorker);

  const secretRotationWorker = new Worker(
    'pgos-secret-rotation',
    async (job: Job) => {
      if (job.name === 'rotate-agent-secrets') {
        const { rotateAgentSecrets } = await import('../services/ssh-provision.js');
        const url = (job.data as { targetRotateUrl?: string }).targetRotateUrl;
        if (url) await rotateAgentSecrets(url);
        await beat('secret-rotation');
      }
    },
    { connection: queueConnection() },
  );
  workers.push(secretRotationWorker);

  const parityWorker = new Worker(
    'pgos-parity',
    async (job: Job) => {
      if (job.name === 'parity-stale-scan') {
        await scanParityStale();
      }
    },
    { connection: queueConnection() },
  );
  workers.push(parityWorker);

  // H-02: merge_outbox consumer (local FS apply or remote merge_apply.yml)
  workers.push(await startMergeOutboxWorker());

  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`[worker ${w.name}] job ${job?.name} failed:`, err);
    });
  }

  return workers;
}

export async function scheduleRepeatableJobs(): Promise<void> {
  await healthQueue.add(
    'stale-lock-scan',
    {},
    {
      repeat: { every: 15_000 },
      jobId: 'repeat-stale-lock-scan',
      removeOnComplete: true,
    },
  );
  await healthQueue.add(
    'dead-letter-escalate',
    {},
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'repeat-dlq-escalate',
      removeOnComplete: true,
    },
  );
  await healthQueue.add(
    'redis-failover-check',
    {},
    {
      repeat: { every: 30_000 },
      jobId: 'repeat-redis-failover',
      removeOnComplete: true,
    },
  );
  await healthQueue.add(
    'tier-b-probe',
    {},
    {
      repeat: { every: 5 * 60 * 1000 },
      jobId: 'repeat-tier-b-probe',
      removeOnComplete: true,
    },
  );

  await secretRotationQueue.add(
    'rotate-agent-secrets',
    // ENV-01: schema-backed AGENT_ROTATE_URL (no raw process.env)
    { targetRotateUrl: getEnv().AGENT_ROTATE_URL || '' },
    {
      repeat: { pattern: '0 4 1 */3 *' },
      jobId: 'repeat-secret-rotation',
      removeOnComplete: true,
    },
  );

  await parityQueue.add(
    'parity-stale-scan',
    {},
    {
      repeat: { every: 6 * 60 * 60 * 1000 },
      jobId: 'repeat-parity-stale-scan',
      removeOnComplete: true,
    },
  );

  const { uidReconcileQueue } = await import('./queues.js');
  await uidReconcileQueue.add(
    'nightly-reconcile',
    {},
    {
      repeat: { pattern: '0 3 * * *' },
      jobId: 'repeat-uid-nightly',
      removeOnComplete: true,
    },
  );

  // H-02: drain merge_outbox every 5 minutes
  await mergeOutboxQueue.add(
    'drain-pending',
    {},
    {
      repeat: { every: 5 * 60 * 1000 },
      jobId: 'repeat-merge-outbox-drain',
      removeOnComplete: true,
    },
  );
}

async function beat(name: string): Promise<void> {
  await getPool().query(
    `INSERT INTO cron_heartbeats (name, last_beat_at) VALUES ($1, now())
     ON CONFLICT (name) DO UPDATE SET last_beat_at = now()`,
    [name],
  );
}

async function scanStaleLocks(): Promise<void> {
  const env = getEnv();
  const staleBefore = new Date(Date.now() - env.HEARTBEAT_STALE_AFTER_MS);
  const { rows } = await getPool().query(
    `SELECT * FROM pg_locks WHERE last_heartbeat_at < $1`,
    [staleBefore.toISOString()],
  );

  const handledJobs = new Set<string>();

  for (const lock of rows) {
    await lockService.reclaim(lock.lock_key, 'STALE_RECOVERED');
    if (lock.job_id) {
      handledJobs.add(String(lock.job_id));
      // Skip failure handler path — LOCK_STALE is reclaimed; redispatch once here
      await getPool().query(
        `UPDATE jobs SET status = 'LOCK_STALE', error_code = 'E005',
           error_detail = $2, lock_key = NULL, fencing_token = NULL, updated_at = now()
         WHERE id = $1`,
        [lock.job_id, 'Lock considered stale after missed heartbeats'],
      );
      await jobService.recordError(
        lock.job_id,
        'E005',
        'Lock considered stale after missed heartbeats',
      );
      const job = await jobService.getById(lock.job_id);
      if (job && job.attempt < job.maxAttempts) {
        await getPool().query(
          `UPDATE jobs SET status = 'QUEUED', attempt = attempt + 1 WHERE id = $1`,
          [lock.job_id],
        );
        await jobService.dispatchJob(lock.job_id);
      } else if (job) {
        await jobService.updateStatus(lock.job_id, {
          status: 'DEAD_LETTER',
          errorCode: 'E020',
          errorDetail: 'Exhausted attempts after lock stale',
        });
      }
    }
    await sendAlert({
      title: 'Stale lock recovered',
      severity: 'low',
      body: `Lock ${lock.lock_key} reclaimed`,
      code: 'E005',
      jobId: lock.job_id,
    });
  }

  // Jobs with missing heartbeats but maybe no pg_locks row
  const { rows: staleJobs } = await getPool().query(
    `SELECT id, lock_key, attempt, max_attempts FROM jobs
     WHERE status = ANY($1::text[])
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < $2`,
    [
      ['STAGING', 'VALIDATING', 'COMMITTING', 'POST_COMMIT_VERIFY', 'DISPATCHING'],
      staleBefore.toISOString(),
    ],
  );
  for (const j of staleJobs) {
    if (handledJobs.has(String(j.id))) continue;
    if (j.lock_key) {
      await lockService.reclaim(j.lock_key, 'STALE_RECOVERED');
    }
    await getPool().query(
      `UPDATE jobs SET status = 'LOCK_STALE', error_code = 'E005',
         error_detail = $2, lock_key = NULL, fencing_token = NULL, updated_at = now()
       WHERE id = $1`,
      [j.id, 'Job heartbeat stale'],
    );
    await jobService.recordError(j.id, 'E005', 'Job heartbeat stale');
    if (j.attempt < j.max_attempts) {
      await getPool().query(
        `UPDATE jobs SET status = 'QUEUED', attempt = attempt + 1 WHERE id = $1`,
        [j.id],
      );
      await jobService.dispatchJob(j.id);
    }
  }
}

async function escalateDeadLetters(): Promise<void> {
  // M-03: 24h high / 72h critical emails project admin_contacts (ADMIN_EMAIL CC)
  const result = await escalateUnresolvedDeadLetters();
  if (result.escalated24 > 0 || result.escalated72 > 0) {
    console.info(
      `[dead-letter-escalate] 24h=${result.escalated24} 72h=${result.escalated72}`,
    );
  }
  await beat('dead-letter-escalate');
}

async function checkRedisFailover(): Promise<void> {
  const redis = getRedis();
  const redisId = await redis.get(REDIS_INSTANCE_KEY);
  const { rows } = await getPool().query(
    `SELECT instance_id::text FROM redis_instance_state WHERE id = 1`,
  );
  const pgId = rows[0]?.instance_id as string | undefined;

  if (!redisId && pgId) {
    // Redis lost key (restart without persistence) — restore from Postgres, do not rotate
    await redis.set(REDIS_INSTANCE_KEY, pgId);
    return;
  }

  if (redisId && pgId && redisId.toLowerCase() !== pgId.toLowerCase()) {
    // Divergence: prefer rotating to a new shared id so both sides agree
    // and all prior fencing tokens are invalidated.
    await lockService.rotateInstanceIdOnFailover();
    return;
  }

  await lockService.ensureInstanceId();
}

/**
 * M-04: Tier B health — real GitHub Actions / runner signal (not Redis+Postgres latency).
 * Complements scheduled godot_health.yml which POSTs probe ingestion to /tiers/B/probe.
 */
async function probeTierB(): Promise<void> {
  const { tierProbeMetadata } = await import('../services/tier-probe.js');
  const result = await githubService.probeTierBAvailability();
  await schedulerService.recordProbe(
    'B',
    Math.round(result.coldStartMs),
    result.degraded,
    tierProbeMetadata(result),
  );
  await beat('tier-b-probe');
  if (result.degraded) {
    await sendAlert({
      title: 'Tier B probe degraded',
      severity: 'high',
      body: [
        `source=${result.source}`,
        `runner_online=${result.tier_b_runner_online}`,
        `godot_cache_warm=${result.godot_cache_warm}`,
        `cold_start_ms=${result.coldStartMs}`,
        result.detail,
      ].join(' '),
      code: 'E001',
    });
  }
}

/**
 * Resolve GitHub run id after workflow_dispatch.
 * On timeout, record DISPATCH_TIMEOUT once — JobService.handleFailure owns retries
 * (including tier flip). Do NOT double-increment attempt here.
 */
async function resolveDispatch(data: {
  jobId: string;
  tier: 'A' | 'B';
  attempt: number;
}): Promise<void> {
  const env = getEnv();
  const job = await jobService.getById(data.jobId);
  if (!job) return;
  // Only resolve while still dispatching
  if (job.status !== 'DISPATCHING') return;

  const runId = await githubService.resolveRunId(data.jobId, env.DISPATCH_TIMEOUT_MS);
  if (runId != null) {
    await jobService.updateStatus(data.jobId, {
      status: 'STAGING',
      githubRunId: runId,
      metadata: { dispatchResolved: true },
    });
    return;
  }

  await jobService.updateStatus(data.jobId, {
    status: 'DISPATCH_TIMEOUT',
    errorCode: 'E001',
    errorDetail: `No runner picked up dispatch within ${env.DISPATCH_TIMEOUT_MS}ms on tier ${data.tier}`,
  });
  // handleFailure (inside updateStatus) retries other tier / dead-letters

  const after = await jobService.getById(data.jobId);
  if (
    after &&
    after.attempt >= env.DISPATCH_MAX_CONSECUTIVE_FAILURES &&
    after.status === 'DEAD_LETTER'
  ) {
    await sendAlert({
      title: 'Dispatch failed max consecutive times',
      severity: 'high',
      body: `Job ${data.jobId} — check runner availability`,
      code: 'E001',
      jobId: data.jobId,
    });
  }
}

async function scanParityStale(): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT created_at FROM parity_checks ORDER BY created_at DESC LIMIT 1`,
  );
  const staleAfterMs = 48 * 60 * 60 * 1000;
  const lastAt = rows[0]?.created_at
    ? new Date(rows[0].created_at as string).getTime()
    : 0;
  if (Date.now() - lastAt > staleAfterMs) {
    await sendAlert({
      title: 'Tier parity checks stale',
      severity: 'medium',
      body: rows.length
        ? `Last parity check ${rows[0].created_at} (>48h ago)`
        : 'No parity checks recorded yet',
      code: 'E010',
    });
  }
  await beat('parity-stale-scan');
}

async function nightlyUidReconcile(): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT id, project_root, metadata FROM projects`,
  );
  for (const p of rows) {
    const result = await uidService.autoResolveDuplicates(p.id, {
      projectRoot: p.project_root ? String(p.project_root) : undefined,
      runGodot: true,
      metadata:
        p.metadata && typeof p.metadata === 'object'
          ? (p.metadata as Record<string, unknown>)
          : {},
    });
    if (result.manual.length > 0) {
      await sendAlert({
        title: 'UID duplicates require manual review',
        severity: 'medium',
        body: JSON.stringify({
          manual: result.manual,
          filesTouched: result.filesTouched,
          fileMode: result.fileMode,
          godotOk: result.godotOk,
        }),
        code: 'E008',
        projectId: p.id,
      });
    }
    if (result.fixed.length > 0) {
      await sendAlert({
        title: 'UID duplicates auto-fixed',
        severity: 'low',
        body: `Fixed ${result.fixed.length} mappings; filesTouched=${result.filesTouched?.length ?? 0}; mode=${result.fileMode ?? 'db-only'}`,
        code: 'E007',
        projectId: p.id,
      });
    }
  }
}
