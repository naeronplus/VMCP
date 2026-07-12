import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate, requireRole } from '../middleware/auth.js';
import { listAuditLogs } from '../services/audit-service.js';
import { schedulerService } from '../services/scheduler-service.js';
import { getPool } from '../db/pool.js';
import { lockService } from '../services/lock-service.js';
import { evaluateParityReport } from '../services/parity-service.js';
import { z } from 'zod';
import { ERROR_CATALOG } from '@vibrato/shared';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/audit-logs',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const q = req.query as {
        limit?: string;
        resourceType?: string;
        resourceId?: string;
      };
      const logs = await listAuditLogs({
        limit: q.limit ? Number(q.limit) : 100,
        resourceType: q.resourceType,
        resourceId: q.resourceId,
      });
      return { logs };
    },
  );

  app.get(
    '/tiers',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      const tiers = await schedulerService.getTierHealth();
      return { tiers };
    },
  );

  app.post(
    '/tiers/:tier/enable',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const { tier } = req.params as { tier: 'A' | 'B' };
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      await schedulerService.setTierEnabled(tier, body.enabled);
      return { ok: true };
    },
  );

  /**
   * M-04: Ingest probe results from godot_health.yml (or operators).
   * Body carries real runner / Godot cache metrics — not infra ping.
   */
  app.post(
    '/tiers/:tier/probe',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const { tier } = req.params as { tier: string };
      if (tier !== 'A' && tier !== 'B') {
        return reply.code(400).send({ error: { message: 'tier must be A or B' } });
      }
      const body = z
        .object({
          runnerOnline: z.boolean().optional(),
          godotCacheWarm: z.boolean().nullable().optional(),
          coldStartMs: z.number().nonnegative().optional(),
          wallMs: z.number().nonnegative().optional(),
          detail: z.string().optional(),
          /** Allow GitHub-side probe to force degraded flag */
          degraded: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const { evaluateTierBFromWorkflowIngest, tierProbeMetadata } =
        await import('../services/tier-probe.js');

      let result =
        tier === 'B'
          ? evaluateTierBFromWorkflowIngest({
              runnerOnline: body.runnerOnline,
              godotCacheWarm: body.godotCacheWarm,
              coldStartMs: body.coldStartMs,
              wallMs: body.wallMs,
              detail: body.detail,
            })
          : {
              // Tier A ingest: self-hosted signal from optional future health path
              tier_b_runner_online: false,
              godot_cache_warm: body.godotCacheWarm ?? null,
              coldStartMs: Math.round(body.coldStartMs ?? body.wallMs ?? 0),
              degraded:
                body.runnerOnline === false ||
                (body.coldStartMs != null && body.coldStartMs > 120_000),
              source: 'workflow_ingest' as const,
              detail: body.detail ?? 'tier A probe ingest',
              checkedAt: new Date().toISOString(),
            };

      if (body.degraded === true) {
        result = { ...result, degraded: true };
      } else if (body.degraded === false) {
        result = { ...result, degraded: false };
      }

      const meta =
        tier === 'B'
          ? tierProbeMetadata(result as import('../services/tier-probe.js').TierBProbeResult)
          : {
              godot_cache_warm: result.godot_cache_warm,
              probe_source: result.source,
              probe_detail: result.detail,
              probe_checked_at: result.checkedAt,
              tier_a_runner_online: body.runnerOnline ?? null,
            };

      await schedulerService.recordProbe(
        tier,
        Math.round(result.coldStartMs),
        result.degraded,
        meta,
      );

      const tiers = await schedulerService.getTierHealth();
      const row = tiers.find((t) => t.tier === tier);
      return reply.code(200).send({ ok: true, tier: row, probe: result });
    },
  );

  app.get(
    '/parity',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      const { rows } = await getPool().query(
        `SELECT * FROM parity_checks ORDER BY created_at DESC LIMIT 50`,
      );
      return { checks: rows };
    },
  );

  app.post(
    '/parity',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const body = z
        .object({
          tierAChecksum: z.string().default(''),
          tierBChecksum: z.string().default(''),
          tierADurationMs: z.number().default(0),
          tierBDurationMs: z.number().default(0),
          diffS3Key: z.string().optional(),
          /** H-13: when true, record skip and never emit E010 */
          skipped: z.boolean().optional().default(false),
          /** Distinct reason: tier_a_unavailable | reimport_failed_* | checksum_mismatch */
          reason: z.string().optional(),
        })
        .parse(req.body);

      const evaluation = evaluateParityReport({
        tierAChecksum: body.tierAChecksum,
        tierBChecksum: body.tierBChecksum,
        tierADurationMs: body.tierADurationMs,
        tierBDurationMs: body.tierBDurationMs,
        skipped: body.skipped,
        reason: body.reason,
        diffS3Key: body.diffS3Key,
      });

      const { rows } = await getPool().query(
        `INSERT INTO parity_checks
           (tier_a_checksum, tier_b_checksum, tier_a_duration_ms, tier_b_duration_ms,
            passed, diff_s3_key, skipped, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          body.tierAChecksum || (evaluation.skipped ? 'missing-a' : ''),
          body.tierBChecksum || '',
          body.tierADurationMs,
          body.tierBDurationMs,
          evaluation.passed,
          body.diffS3Key ?? null,
          evaluation.skipped,
          evaluation.reason,
        ],
      );

      // H-13: skip path must not raise E010. H-12: real failures still alert.
      if (evaluation.emitE010) {
        const { sendAlert } = await import('../services/alert-service.js');
        await sendAlert({
          title: 'Tier parity failure',
          severity: 'high',
          body: `reason=${evaluation.reason ?? 'checksum_mismatch'} A=${body.tierAChecksum} B=${body.tierBChecksum}`,
          code: 'E010',
        });
      }

      return reply.code(201).send({
        check: rows[0],
        evaluation: {
          passed: evaluation.passed,
          skipped: evaluation.skipped,
          reason: evaluation.reason,
          emitE010: evaluation.emitE010,
        },
      });
    },
  );

  app.get(
    '/errors/catalog',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      return { catalog: ERROR_CATALOG };
    },
  );

  app.get(
    '/cron-heartbeats',
    { preHandler: [authenticate, requireRole('admin')] },
    async () => {
      const { rows } = await getPool().query(`SELECT * FROM cron_heartbeats`);
      return { heartbeats: rows };
    },
  );

  app.post(
    '/redis/simulate-failover',
    { preHandler: [authenticate, requireRole('admin')] },
    async () => {
      const newId = await lockService.rotateInstanceIdOnFailover();
      return { instanceId: newId };
    },
  );

  app.get(
    '/docs/agents.md',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (_req, reply) => {
      const content = readRepoDoc('AGENTS.md');
      if (!content) {
        return reply.code(404).send({ error: { message: 'AGENTS.md not found' } });
      }
      return reply.type('text/markdown').send(content);
    },
  );

  app.get(
    '/docs/errors/:code',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      const { code } = req.params as { code: string };
      if (!/^E\d{3}$/.test(code)) {
        return reply.code(400).send({ error: { message: 'Invalid error code' } });
      }
      const content = readRepoDoc(path.join('docs', 'errors', `${code}.md`));
      if (!content) {
        return reply.code(404).send({ error: { message: `${code} documentation not found` } });
      }
      return reply.type('text/markdown').send(content);
    },
  );
}

function readRepoDoc(relativePath: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), '../../', relativePath),
    path.resolve(process.cwd(), '../../../', relativePath),
    path.resolve(process.cwd(), 'dist', relativePath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return fs.readFileSync(c, 'utf8');
    }
  }
  return null;
}
