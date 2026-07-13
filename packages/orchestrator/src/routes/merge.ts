import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { applyMerge } from '../services/merge-service.js';
import { getPool } from '../db/pool.js';
import { PathTraversalError } from '@vibrato/shared';
import { audit } from '../services/audit-service.js';
import { getEnv } from '../config/env.js';

/**
 * H-02: Host workflow may complete outbox with service token
 * (PGOS_SERVICE_TOKEN or SANDBOX_INTERNAL_TOKEN) or admin JWT.
 */
async function authenticateMergeOutboxComplete(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const env = getEnv();
    // ENV-02: prefer schema-backed PGOS_SERVICE_TOKEN (no raw process.env)
    const serviceTokens = [
      env.PGOS_SERVICE_TOKEN,
      env.SANDBOX_INTERNAL_TOKEN,
    ].filter((t): t is string => Boolean(t && t.length > 8));
    if (serviceTokens.includes(token)) {
      request.principal = {
        userId: 'service:merge-apply',
        role: 'admin',
        jti: 'service:merge-apply',
        kind: 'service',
      };
      return;
    }
  }
  await authenticate(request, reply);
  if (reply.sent) return;
  await requireRole('admin')(request, reply);
}

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

  /**
   * H-02: Host-side merge-apply reports success → outbox applied + overrides.merged_hash.
   */
  app.post(
    '/merge-outbox/:id/complete',
    { preHandler: [authenticateMergeOutboxComplete] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          mergedHash: z.string().min(1),
          detail: z.string().optional(),
        })
        .parse(req.body ?? {});

      const { rows } = await getPool().query(
        `SELECT id, override_id, status FROM merge_outbox WHERE id = $1`,
        [id],
      );
      if (!rows[0]) {
        return reply.code(404).send({ error: { message: 'Outbox row not found' } });
      }

      await getPool().query(
        `UPDATE merge_outbox
         SET status = 'applied', applied_at = now(), detail = $2
         WHERE id = $1`,
        [id, body.detail ?? 'host merge-apply complete'],
      );
      await getPool().query(
        `UPDATE overrides SET merged_hash = $1, apply_mode = 'outbox' WHERE id = $2`,
        [body.mergedHash, rows[0].override_id],
      );
      await audit({
        actorId: req.principal?.userId,
        actorRole: req.principal?.role,
        action: 'merge.outbox_applied',
        resourceType: 'merge_outbox',
        resourceId: id,
        detail: {
          mergedHash: body.mergedHash,
          via: 'host_complete',
        },
      });
      return { ok: true, id, status: 'applied' };
    },
  );
}
