import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { secretService } from '../services/secret-service.js';
import { loginRateLimitHook } from '../middleware/rate-limit.js';

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Worker resolves dispatch JWE (§9.4).
   * Callback credential is embedded in the JWE — not passed as workflow input.
   * No bearer auth: possession of valid dispatch JWE + embedded callback hash is the proof.
   */
  app.post(
    '/resolve-secret',
    { preHandler: [loginRateLimitHook] },
    async (req, reply) => {
      if (reply.sent) return;

      const body = z.object({ jwe: z.string().min(1) }).parse(req.body);

      const secrets = await secretService.resolveDispatchJwe(body.jwe);
      if (!secrets) {
        // L-02: structured 404 — do NOT use E007 (UID_DUPLICATE_AUTO_FIXED).
        // This is dispatch JWE / secret-reference not found, not a UID issue.
        return reply.code(404).send({
          error: {
            code: 'SECRET_NOT_FOUND',
            message:
              'Secret not found, expired, already consumed, or invalid dispatch JWE',
          },
        });
      }
      return { secrets };
    },
  );
}