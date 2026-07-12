import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { extensionService } from '../services/extension-service.js';
import { errorPayload, type ErrorCode } from '@vibrato/shared';

export async function extensionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/extensions',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      const policies = await extensionService.listPolicies();
      return { policies };
    },
  );

  app.post(
    '/extensions',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req, reply) => {
      const body = z
        .object({
          extensionId: z.string().min(1),
          name: z.string().min(1),
          godotVersionRange: z.string().optional(),
          maxCpu: z.number().optional(),
          maxMemoryMiB: z.number().optional(),
          maxDiskMiB: z.number().optional(),
          timeoutSeconds: z.number().optional(),
        })
        .parse(req.body);
      const policy = await extensionService.upsertPolicy(body);
      return reply.code(201).send({ policy });
    },
  );

  app.post(
    '/execute-extension',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const body = z
        .object({
          extensionId: z.string(),
          projectId: z.string().uuid(),
          inputs: z.record(z.unknown()).default({}),
          network: z.boolean().optional(),
        })
        .parse(req.body);

      const result = await extensionService.execute(body, req.principal!.userId);
      if (result.error) {
        const code = (result.code as ErrorCode) ?? undefined;
        const status =
          code === 'E016' ? 403 : code === 'E009' ? 504 : code === 'E017' ? 422 : 400;
        return reply.code(status).send(
          code
            ? errorPayload(code, result.error)
            : { error: { message: result.error } },
        );
      }
      return { result: result.result };
    },
  );

  app.get(
    '/extension-approvals',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const status = (req.query as { status?: string }).status;
      const approvals = await extensionService.listApprovals(status);
      return { approvals };
    },
  );

  app.post(
    '/extension-approvals',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const body = z
        .object({
          extensionId: z.string(),
          requestedDomains: z.array(z.string()),
          reason: z.string(),
          riskAssessment: z.string().default(''),
        })
        .parse(req.body);
      const approval = await extensionService.requestNetworkAccess({
        ...body,
        requestedBy: req.principal!.userId,
      });
      return reply.code(201).send({ approval });
    },
  );

  app.post(
    '/extension-approvals/:id/review',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ status: z.enum(['approved', 'rejected']) })
        .parse(req.body);
      const approval = await extensionService.reviewApproval(
        id,
        body.status,
        req.principal!.userId,
      );
      return { approval };
    },
  );
}
