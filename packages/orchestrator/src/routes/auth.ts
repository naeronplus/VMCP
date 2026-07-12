import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  authenticatePassword,
  createSession,
  destroySession,
  issueApiToken,
  revokeToken,
  ensureBootstrapAdmin,
} from '../services/auth-service.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { loginRateLimitHook } from '../middleware/rate-limit.js';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    await loginRateLimitHook(req, reply);
    if (reply.sent) return;
    await ensureBootstrapAdmin();
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
      })
      .parse(req.body);

    const user = await authenticatePassword(body.email, body.password);
    if (!user) {
      return reply.code(401).send({
        error: { code: 'E015', message: 'Invalid credentials' },
      });
    }
    const sessionId = await createSession(user.id);
    const env = getEnv();
    reply.setCookie('pgos_session', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: env.NODE_ENV === 'production',
      maxAge: env.SESSION_TTL_SECONDS,
    });
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post(
    '/auth/logout',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const sessionId = req.cookies?.pgos_session;
      if (sessionId) await destroySession(sessionId);
      reply.clearCookie('pgos_session', { path: '/' });
      return { ok: true };
    },
  );

  app.get(
    '/auth/me',
    { preHandler: [authenticate] },
    async (req) => {
      const { rows } = await getPool().query(
        `SELECT id, email, display_name, role FROM users WHERE id = $1`,
        [req.principal!.userId],
      );
      return {
        principal: req.principal,
        user: rows[0] ?? null,
      };
    },
  );

  app.post(
    '/auth/tokens',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1),
          role: z.enum(['viewer', 'operator', 'admin']),
          userId: z.string().uuid().optional(),
          expiresInSeconds: z.number().optional(),
        })
        .parse(req.body);
      const result = await issueApiToken({
        userId: body.userId ?? req.principal!.userId,
        role: body.role,
        name: body.name,
        expiresInSeconds: body.expiresInSeconds,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/auth/tokens/:jti/revoke',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const { jti } = req.params as { jti: string };
      const body = (req.body ?? {}) as { reason?: string };
      await revokeToken(jti, body.reason);
      return { ok: true };
    },
  );

  app.get(
    '/auth/tokens',
    { preHandler: [authenticate, requireRole('admin')] },
    async () => {
      const { rows } = await getPool().query(
        `SELECT id, jti, name, role, user_id, revoked_at, expires_at, created_at
         FROM api_tokens ORDER BY created_at DESC LIMIT 100`,
      );
      return { tokens: rows };
    },
  );
}
