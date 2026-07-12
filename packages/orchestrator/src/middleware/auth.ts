import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasMinRole, type Role } from '@vibrato/shared';
import {
  parseCallbackToken,
  resolveSession,
  verifyBearer,
  type AuthPrincipal,
} from '../services/auth-service.js';
import { jobService } from '../services/job-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}

/**
 * Fastify only short-circuits the lifecycle when the reply is sent *and*
 * the hook returns after `reply.send`, or when an error is thrown.
 * We use `return reply...` consistently so handlers never run unauthorized.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    // Callback token path: jobId.secret (not a JWT)
    if (token.includes('.') && !token.startsWith('eyJ')) {
      const parsed = parseCallbackToken(token);
      if (parsed) {
        const ok = await jobService.verifyCallbackToken(parsed.jobId, token);
        if (ok) {
          request.principal = {
            userId: `callback:${parsed.jobId}`,
            role: 'callback',
            jti: `callback:${parsed.jobId}`,
            kind: 'callback',
            jobId: parsed.jobId,
          };
          return;
        }
      }
    }
    const principal = await verifyBearer(token);
    if (principal) {
      request.principal = principal;
      return;
    }
  }

  const sessionId = request.cookies?.pgos_session;
  if (sessionId) {
    const principal = await resolveSession(sessionId);
    if (principal) {
      request.principal = principal;
      return;
    }
  }

  return reply.code(401).send({ error: { code: 'E015', message: 'Unauthorized' } });
}

export function requireRole(minRole: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // If a prior hook already sent a response, stop.
    if (reply.sent) return;

    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'E015', message: 'Unauthorized' } });
    }
    if (!hasMinRole(request.principal.role, minRole)) {
      return reply.code(403).send({
        error: {
          code: 'E015',
          message: `Requires role ${minRole}`,
        },
      });
    }
  };
}

/** Exact role — callback endpoints must not admit operator/admin via rank. */
export function requireExactRole(role: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return;
    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'E015', message: 'Unauthorized' } });
    }
    if (request.principal.role !== role) {
      return reply.code(403).send({
        error: { code: 'E015', message: `Requires exact role ${role}` },
      });
    }
  };
}
