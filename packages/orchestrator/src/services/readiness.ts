/**
 * Orchestrator readiness (M-09): Postgres + Redis must answer.
 * Used by GET /ready so Railway healthchecks fail when deps are down.
 */

export type ReadinessDeps = {
  query: () => Promise<unknown>;
  ping: () => Promise<unknown>;
};

export type ReadinessResult =
  | { ok: true }
  | { ok: false; error: string; statusCode: 503 };

/**
 * Pure readiness check — inject pool/redis for unit tests.
 */
export async function checkOrchestratorReadiness(
  deps: ReadinessDeps,
): Promise<ReadinessResult> {
  try {
    await deps.query();
    await deps.ping();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      statusCode: 503,
    };
  }
}

/** Production wiring: real pool + Redis. */
export async function checkLiveReadiness(): Promise<ReadinessResult> {
  const { getPool } = await import('../db/pool.js');
  const { getRedis } = await import('../lib/redis.js');
  return checkOrchestratorReadiness({
    query: () => getPool().query('SELECT 1'),
    ping: () => getRedis().ping(),
  });
}
