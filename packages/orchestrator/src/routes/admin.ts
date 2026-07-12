import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate, requireRole } from '../middleware/auth.js';
import { listAuditLogs } from '../services/audit-service.js';
import { schedulerService } from '../services/scheduler-service.js';
import { getPool } from '../db/pool.js';
import { lockService } from '../services/lock-service.js';
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
          tierAChecksum: z.string(),
          tierBChecksum: z.string(),
          tierADurationMs: z.number(),
          tierBDurationMs: z.number(),
          diffS3Key: z.string().optional(),
        })
        .parse(req.body);
      const passed = body.tierAChecksum === body.tierBChecksum;
      const { rows } = await getPool().query(
        `INSERT INTO parity_checks
           (tier_a_checksum, tier_b_checksum, tier_a_duration_ms, tier_b_duration_ms, passed, diff_s3_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          body.tierAChecksum,
          body.tierBChecksum,
          body.tierADurationMs,
          body.tierBDurationMs,
          passed,
          body.diffS3Key ?? null,
        ],
      );
      if (!passed) {
        const { sendAlert } = await import('../services/alert-service.js');
        await sendAlert({
          title: 'Tier parity failure',
          severity: 'high',
          body: `A=${body.tierAChecksum} B=${body.tierBChecksum}`,
          code: 'E010',
        });
      }
      return reply.code(201).send({ check: rows[0] });
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
