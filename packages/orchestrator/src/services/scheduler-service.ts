import type { WorkerTier } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { getRedis } from '../lib/redis.js';

/**
 * Dynamic scheduling (§6.2):
 * - Prefer Tier A when high_volume and queue depth exceeds threshold
 * - Divert to Tier A when Tier B cold-start would exceed deadline
 * - Respect tier enable/degraded flags
 */
export class SchedulerService {
  private readonly queueKey = 'pgos:job_priority_queue';

  async enqueuePriority(jobId: string, priority: number): Promise<void> {
    await getRedis().zadd(this.queueKey, priority, jobId);
  }

  async queueDepth(): Promise<number> {
    return getRedis().zcard(this.queueKey);
  }

  async selectTier(opts: {
    preferredTier?: WorkerTier;
    projectHighVolume: boolean;
    deadlineMs?: number;
  }): Promise<WorkerTier> {
    const env = getEnv();
    const { rows } = await getPool().query<{
      tier: string;
      enabled: boolean;
      degraded: boolean;
      avg_cold_start_ms: number | null;
    }>(`SELECT tier, enabled, degraded, avg_cold_start_ms FROM tier_health`);

    const health = Object.fromEntries(
      rows.map((r) => [
        r.tier,
        {
          enabled: r.enabled,
          degraded: r.degraded,
          avg_cold_start_ms: r.avg_cold_start_ms,
        },
      ]),
    ) as unknown as Record<
      WorkerTier,
      { enabled: boolean; degraded: boolean; avg_cold_start_ms: number | null }
    >;

    const aOk = env.TIER_A_ENABLED && health.A?.enabled && !health.A?.degraded;
    const bOk = env.TIER_B_ENABLED && health.B?.enabled && !health.B?.degraded;

    if (opts.preferredTier === 'A' && aOk) return 'A';
    if (opts.preferredTier === 'B' && bOk) return 'B';

    const depth = await this.queueDepth();
    if (aOk && opts.projectHighVolume && depth >= env.TIER_A_QUEUE_THRESHOLD) {
      return 'A';
    }

    if (opts.deadlineMs && bOk) {
      const cold = health.B?.avg_cold_start_ms ?? 90_000;
      if (cold > opts.deadlineMs * 0.5 && aOk) {
        return 'A';
      }
    }

    if (bOk) return 'B';
    if (aOk) return 'A';
    // Fallback even if degraded — better than refusing entirely
    return 'B';
  }

  async setTierEnabled(tier: WorkerTier, enabled: boolean): Promise<void> {
    await getPool().query(
      `UPDATE tier_health SET enabled = $2 WHERE tier = $1`,
      [tier, enabled],
    );
  }

  async recordProbe(
    tier: WorkerTier,
    coldStartMs: number,
    degraded: boolean,
  ): Promise<void> {
    await getPool().query(
      `UPDATE tier_health
       SET avg_cold_start_ms = COALESCE(
             (avg_cold_start_ms * 0.7 + $2 * 0.3)::int,
             $2
           ),
           last_probe_at = now(),
           degraded = $3
       WHERE tier = $1`,
      [tier, coldStartMs, degraded],
    );
  }

  async getTierHealth(): Promise<unknown[]> {
    const { rows } = await getPool().query(`SELECT * FROM tier_health ORDER BY tier`);
    return rows;
  }
}

export const schedulerService = new SchedulerService();
