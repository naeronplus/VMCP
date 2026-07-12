import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { applyMerge } from '../services/merge-service.js';
import { getPool } from '../db/pool.js';
import { PathTraversalError } from '@vibrato/shared';

export async function mergeRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/merge',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const body = z
        .object({
          projectId: z.string().uuid(),
          path: z.string().min(1),
          patch: z.record(z.unknown()),
        })
        .parse(req.body);

      const { rows } = await getPool().query(
        `SELECT project_root FROM projects WHERE id = $1`,
        [body.projectId],
      );
      if (!rows[0]) {
        return reply.code(404).send({ error: { message: 'Project not found' } });
      }

      try {
        const result = await applyMerge(
          body,
          { userId: req.principal!.userId, role: req.principal!.role },
          rows[0].project_root,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({
            error: { code: 'E014', message: err.message },
          });
        }
        const e = err as { statusCode?: number; code?: string; message: string };
        return reply.code(e.statusCode ?? 500).send({
          error: { code: e.code, message: e.message },
        });
      }
    },
  );
}
