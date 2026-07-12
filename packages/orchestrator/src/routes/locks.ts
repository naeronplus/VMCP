import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { lockService } from '../services/lock-service.js';
import { jobService } from '../services/job-service.js';

export async function lockRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/locks',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      const locks = await lockService.listActiveLocks();
      return { locks };
    },
  );

  app.get(
    '/locks/:lockKey/history',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req) => {
      const { lockKey } = req.params as { lockKey: string };
      const history = await lockService.getHistory(decodeURIComponent(lockKey));
      return { history };
    },
  );

  app.post(
    '/locks/reclaim',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req, reply) => {
      const body = z
        .object({
          lockKey: z.string().min(1),
          reason: z.string().min(1),
        })
        .parse(req.body);

      const { token } = await lockService.reclaim(
        body.lockKey,
        'ADMIN_RECLAIM',
        req.principal!.userId,
      );

      await jobService.handleAdminReclaim(body.lockKey, body.reason);

      return reply.send({
        ok: true,
        newFencingToken: token,
        message: 'Lock reclaimed; affected jobs redispatched or moved to dead-letter',
      });
    },
  );

  /** Used by commit-agent for fencing validation (§4.2). */
  app.post(
    '/locks/validate-token',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req) => {
      const body = z
        .object({
          lockKey: z.string(),
          owner: z.string(),
          token: z.string(),
        })
        .parse(req.body);
      const valid = await lockService.validateFencingToken(
        body.lockKey,
        body.owner,
        body.token,
      );
      return { valid };
    },
  );
}