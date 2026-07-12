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
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await getPool().query(
      `UPDATE tier_health
       SET avg_cold_start_ms = COALESCE(
             (avg_cold_start_ms * 0.7 + $2 * 0.3)::int,
             $2
           ),
           last_probe_at = now(),
           degraded = $3,
           metadata = CASE
             WHEN $4::jsonb IS NULL THEN metadata
             ELSE COALESCE(metadata, '{}'::jsonb) || $4::jsonb
           END
       WHERE tier = $1`,
      [
        tier,
        coldStartMs,
        degraded,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  /**
   * GET /tiers — flatten M-04 probe metrics from metadata onto each row.
   */
  async getTierHealth(): Promise<Record<string, unknown>[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM tier_health ORDER BY tier`,
    );
    return rows.map((row) => {
      const meta =
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : {};
      return {
        ...row,
        // Explicit top-level fields for dashboard / operators (6.7.3)
        tier_b_runner_online:
          row.tier === 'B'
            ? (meta.tier_b_runner_online as boolean | undefined) ?? null
            : null,
        godot_cache_warm:
          (meta.godot_cache_warm as boolean | null | undefined) ?? null,
        probe_source: (meta.probe_source as string | undefined) ?? null,
        probe_detail: (meta.probe_detail as string | undefined) ?? null,
        probe_checked_at: (meta.probe_checked_at as string | undefined) ?? null,
        last_health_run_id:
          (meta.last_health_run_id as number | null | undefined) ?? null,
        last_health_run_conclusion:
          (meta.last_health_run_conclusion as string | null | undefined) ?? null,
        last_health_run_age_ms:
          (meta.last_health_run_age_ms as number | null | undefined) ?? null,
        actions_api_ok:
          (meta.actions_api_ok as boolean | null | undefined) ?? null,
      };
    });
  }
}

export const schedulerService = new SchedulerService();
