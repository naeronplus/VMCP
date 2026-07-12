import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER_B_COLD_START_DEGRADED_MS,
  TIER_B_HEALTH_RUN_MAX_AGE_MS,
  estimateColdStartMs,
  evaluateTierBFromWorkflowIngest,
  evaluateTierBFromWorkflowRuns,
  mockTierBProbeHealthy,
  tierProbeMetadata,
  type WorkflowRunSummary,
} from '../src/services/tier-probe.js';

function run(
  partial: Partial<WorkflowRunSummary> & Pick<WorkflowRunSummary, 'id' | 'createdAt'>,
): WorkflowRunSummary {
  return {
    status: 'completed',
    conclusion: 'success',
    ...partial,
  };
}

describe('Tier B probe evaluation (M-04)', () => {
  const now = Date.parse('2026-07-12T12:00:00.000Z');

  it('marks offline when Actions API is down', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: false,
      healthRuns: [],
    });
    assert.equal(r.tier_b_runner_online, false);
    assert.equal(r.degraded, true);
    assert.equal(r.source, 'github_api');
    assert.equal(r.actionsApiOk, false);
  });

  it('uses recent successful godot_health run as runner online', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: true,
      healthRuns: [
        run({
          id: 42,
          createdAt: new Date(now - 10 * 60_000).toISOString(),
          runStartedAt: new Date(now - 10 * 60_000 + 15_000).toISOString(),
          conclusion: 'success',
        }),
      ],
    });
    assert.equal(r.tier_b_runner_online, true);
    assert.equal(r.degraded, false);
    assert.equal(r.coldStartMs, 15_000);
    assert.equal(r.lastHealthRunId, 42);
    assert.ok((r.lastHealthRunAgeMs ?? 0) < TIER_B_HEALTH_RUN_MAX_AGE_MS);
  });

  it('degrades when last success is older than max age', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: true,
      healthRuns: [
        run({
          id: 7,
          createdAt: new Date(now - TIER_B_HEALTH_RUN_MAX_AGE_MS - 60_000).toISOString(),
          conclusion: 'success',
        }),
      ],
    });
    assert.equal(r.tier_b_runner_online, false);
    assert.equal(r.degraded, true);
  });

  it('degrades on recent failure conclusion', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: true,
      healthRuns: [
        run({
          id: 9,
          createdAt: new Date(now - 5 * 60_000).toISOString(),
          conclusion: 'failure',
        }),
      ],
    });
    assert.equal(r.tier_b_runner_online, false);
    assert.equal(r.degraded, true);
  });

  it('falls back to other workflow runs when health history empty', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: true,
      healthRuns: [],
      otherRuns: [
        run({
          id: 100,
          createdAt: new Date(now - 20 * 60_000).toISOString(),
          runStartedAt: new Date(now - 20 * 60_000 + 8_000).toISOString(),
        }),
      ],
    });
    assert.equal(r.tier_b_runner_online, true);
    assert.equal(r.coldStartMs, 8_000);
  });

  it('API ok but no runs → unproven (online but degraded)', () => {
    const r = evaluateTierBFromWorkflowRuns({
      nowMs: now,
      actionsApiOk: true,
      healthRuns: [],
      otherRuns: [],
    });
    assert.equal(r.tier_b_runner_online, true);
    assert.equal(r.degraded, true);
    assert.match(r.detail, /unproven/i);
  });

  it('workflow ingest sets godot_cache_warm and runner online', () => {
    const r = evaluateTierBFromWorkflowIngest({
      nowMs: now,
      runnerOnline: true,
      godotCacheWarm: true,
      wallMs: 12_000,
      detail: 'from godot_health.yml',
    });
    assert.equal(r.source, 'workflow_ingest');
    assert.equal(r.tier_b_runner_online, true);
    assert.equal(r.godot_cache_warm, true);
    assert.equal(r.coldStartMs, 12_000);
    assert.equal(r.degraded, false);
  });

  it('workflow ingest degrades on slow cold-start', () => {
    const r = evaluateTierBFromWorkflowIngest({
      runnerOnline: true,
      coldStartMs: TIER_B_COLD_START_DEGRADED_MS + 1,
    });
    assert.equal(r.degraded, true);
  });

  it('mock path is healthy without GitHub', () => {
    const r = mockTierBProbeHealthy(now);
    assert.equal(r.source, 'mock');
    assert.equal(r.tier_b_runner_online, true);
    assert.equal(r.degraded, false);
  });

  it('tierProbeMetadata exposes plan metric names', () => {
    const r = evaluateTierBFromWorkflowIngest({
      runnerOnline: true,
      godotCacheWarm: false,
      coldStartMs: 1000,
    });
    const m = tierProbeMetadata(r);
    assert.equal(m.tier_b_runner_online, true);
    assert.equal(m.godot_cache_warm, false);
    assert.equal(m.probe_source, 'workflow_ingest');
  });

  it('estimateColdStartMs prefers run_started_at - created_at', () => {
    const ms = estimateColdStartMs({
      id: 1,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-07-12T12:00:00.000Z',
      runStartedAt: '2026-07-12T12:00:25.000Z',
    });
    assert.equal(ms, 25_000);
  });
});
