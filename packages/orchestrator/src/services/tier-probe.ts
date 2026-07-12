/**
 * M-04: Tier B health probe evaluation (pure helpers).
 * Real signals come from GitHub Actions API and/or godot_health.yml ingestion —
 * never from Redis/Postgres latency alone.
 */

export type TierBProbeSource = 'github_api' | 'workflow_ingest' | 'mock';

export type TierBProbeResult = {
  /** Hosted runner pool / Actions can schedule ubuntu-latest work */
  tier_b_runner_online: boolean;
  /** Godot install/cache warm when known; null if unknown */
  godot_cache_warm: boolean | null;
  /** Estimated cold-start / queue pickup latency in ms when measurable */
  coldStartMs: number;
  degraded: boolean;
  source: TierBProbeSource;
  detail: string;
  checkedAt: string;
  lastHealthRunId?: number | null;
  lastHealthRunConclusion?: string | null;
  lastHealthRunAgeMs?: number | null;
  actionsApiOk?: boolean;
};

/** Health workflow must have succeeded within this window (3× 30m cron). */
export const TIER_B_HEALTH_RUN_MAX_AGE_MS = 90 * 60 * 1000;

/** Cold-start above this marks Tier B degraded for scheduling. */
export const TIER_B_COLD_START_DEGRADED_MS = 120_000;

export type WorkflowRunSummary = {
  id: number;
  status: string | null;
  conclusion: string | null;
  /** ISO timestamps from GitHub */
  createdAt: string;
  updatedAt?: string | null;
  runStartedAt?: string | null;
  /** e.g. "ubuntu-latest" when known */
  runnerLabel?: string | null;
  event?: string | null;
  name?: string | null;
};

/**
 * Evaluate Tier B availability from GitHub workflow run history.
 * Prefers godot_health.yml runs; falls back to any recent completed ubuntu-hosted run.
 */
export function evaluateTierBFromWorkflowRuns(opts: {
  nowMs?: number;
  actionsApiOk: boolean;
  healthRuns: WorkflowRunSummary[];
  /** Optional other recent runs (e.g. godot_worker) used as fallback signal */
  otherRuns?: WorkflowRunSummary[];
  maxAgeMs?: number;
}): TierBProbeResult {
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? TIER_B_HEALTH_RUN_MAX_AGE_MS;
  const checkedAt = new Date(now).toISOString();

  if (!opts.actionsApiOk) {
    return {
      tier_b_runner_online: false,
      godot_cache_warm: null,
      coldStartMs: TIER_B_COLD_START_DEGRADED_MS,
      degraded: true,
      source: 'github_api',
      detail: 'GitHub Actions API unreachable or unauthenticated',
      checkedAt,
      actionsApiOk: false,
    };
  }

  const candidates = [
    ...opts.healthRuns.map((r) => ({ run: r, kind: 'health' as const })),
    ...(opts.otherRuns ?? []).map((r) => ({ run: r, kind: 'other' as const })),
  ].sort(
    (a, b) =>
      new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime(),
  );

  if (candidates.length === 0) {
    // API works but no runs yet — treat as online (hosted pool) but degraded (no proof)
    return {
      tier_b_runner_online: true,
      godot_cache_warm: null,
      coldStartMs: 90_000,
      degraded: true,
      source: 'github_api',
      detail:
        'Actions API OK but no godot_health / worker runs found yet — Tier B unproven',
      checkedAt,
      actionsApiOk: true,
    };
  }

  const latest = candidates[0]!.run;
  const ageMs = Math.max(0, now - new Date(latest.createdAt).getTime());
  const success =
    latest.status === 'completed' && latest.conclusion === 'success';
  const inProgress =
    latest.status === 'in_progress' || latest.status === 'queued';
  const fresh = ageMs <= maxAge;

  const coldStartMs = estimateColdStartMs(latest, now);
  const runnerOnline = (success && fresh) || (inProgress && fresh);

  let degraded = !runnerOnline;
  if (coldStartMs > TIER_B_COLD_START_DEGRADED_MS) degraded = true;
  if (!fresh && success) {
    // Stale success: Actions worked before but probe is outdated
    degraded = true;
  }

  const detailParts = [
    `latest_run=${latest.id}`,
    `status=${latest.status ?? '?'}`,
    `conclusion=${latest.conclusion ?? 'null'}`,
    `age_ms=${ageMs}`,
    `kind=${candidates[0]!.kind}`,
    `cold_start_ms=${coldStartMs}`,
  ];

  return {
    tier_b_runner_online: runnerOnline,
    godot_cache_warm: null,
    coldStartMs,
    degraded,
    source: 'github_api',
    detail: detailParts.join(' '),
    checkedAt,
    lastHealthRunId: latest.id,
    lastHealthRunConclusion: latest.conclusion,
    lastHealthRunAgeMs: ageMs,
    actionsApiOk: true,
  };
}

/**
 * Evaluate an ingested report from godot_health.yml (M-04 workflow path).
 */
export function evaluateTierBFromWorkflowIngest(opts: {
  runnerOnline?: boolean;
  godotCacheWarm?: boolean | null;
  coldStartMs?: number | null;
  wallMs?: number | null;
  detail?: string;
  nowMs?: number;
}): TierBProbeResult {
  const now = opts.nowMs ?? Date.now();
  const cold =
    opts.coldStartMs ??
    opts.wallMs ??
    30_000;
  const runnerOnline = opts.runnerOnline !== false;
  const cache =
    opts.godotCacheWarm === undefined ? null : opts.godotCacheWarm;
  const degraded =
    !runnerOnline || cold > TIER_B_COLD_START_DEGRADED_MS;

  return {
    tier_b_runner_online: runnerOnline,
    godot_cache_warm: cache,
    coldStartMs: Math.round(cold),
    degraded,
    source: 'workflow_ingest',
    detail:
      opts.detail ??
      `workflow_ingest runner_online=${runnerOnline} godot_cache_warm=${cache} cold_ms=${Math.round(cold)}`,
    checkedAt: new Date(now).toISOString(),
    actionsApiOk: true,
  };
}

export function mockTierBProbeHealthy(nowMs?: number): TierBProbeResult {
  const now = nowMs ?? Date.now();
  return {
    tier_b_runner_online: true,
    godot_cache_warm: null,
    coldStartMs: 8_000,
    degraded: false,
    source: 'mock',
    detail: 'GITHUB_MOCK: synthetic healthy Tier B (ubuntu-latest assumed online)',
    checkedAt: new Date(now).toISOString(),
    actionsApiOk: true,
  };
}

/** Approximate cold-start from GitHub run timestamps. */
export function estimateColdStartMs(
  run: WorkflowRunSummary,
  nowMs: number = Date.now(),
): number {
  const created = new Date(run.createdAt).getTime();
  const started = run.runStartedAt
    ? new Date(run.runStartedAt).getTime()
    : NaN;
  if (Number.isFinite(started) && started >= created) {
    return Math.max(0, started - created);
  }
  const updated = run.updatedAt ? new Date(run.updatedAt).getTime() : NaN;
  if (
    run.status === 'completed' &&
    Number.isFinite(updated) &&
    updated >= created
  ) {
    // Full duration as upper-bound proxy when run_started_at missing
    return Math.min(Math.max(0, updated - created), 600_000);
  }
  if (run.status === 'queued' || run.status === 'in_progress') {
    return Math.max(0, nowMs - created);
  }
  return 60_000;
}

/** Flatten probe metrics into tier_health.metadata + API-facing fields. */
export function tierProbeMetadata(result: TierBProbeResult): Record<string, unknown> {
  return {
    tier_b_runner_online: result.tier_b_runner_online,
    godot_cache_warm: result.godot_cache_warm,
    probe_source: result.source,
    probe_detail: result.detail,
    probe_checked_at: result.checkedAt,
    last_health_run_id: result.lastHealthRunId ?? null,
    last_health_run_conclusion: result.lastHealthRunConclusion ?? null,
    last_health_run_age_ms: result.lastHealthRunAgeMs ?? null,
    actions_api_ok: result.actionsApiOk ?? null,
  };
}
