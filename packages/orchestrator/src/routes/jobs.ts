import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireExactRole } from '../middleware/auth.js';
import { jobService } from '../services/job-service.js';
import { JOB_STATUSES } from '@vibrato/shared';

const createJobSchema = z.object({
  projectId: z.string().uuid(),
  commitStrategy: z.enum(['same-machine', 'cross-machine']).optional(),
  godotVersion: z.string().optional(),
  preferredTier: z.enum(['A', 'B']).optional(),
  dependsOnJobId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const statusSchema = z.object({
  status: z.enum(JOB_STATUSES as unknown as [string, ...string[]]),
  metadata: z.record(z.unknown()).optional(),
  errorCode: z.string().optional(),
  errorDetail: z.string().optional(),
  s3StagingPrefix: z.string().optional(),
  s3ValidationReportKey: z.string().optional(),
  s3SnapshotKey: z.string().optional(),
  s3ArtifactsPrefix: z.string().optional(),
  githubRunId: z.number().optional(),
  fencingToken: z.string().optional(),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/jobs',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      if (reply.sent) return;
      try {
        const body = createJobSchema.parse(req.body);
        const job = await jobService.create(body, req.principal!.userId);
        return reply.code(201).send({ job });
      } catch (err) {
        const e = err as { statusCode?: number; message: string; issues?: unknown };
        if (e.issues) {
          return reply.code(400).send({ error: { message: 'Invalid body', detail: e.issues } });
        }
        return reply.code(e.statusCode ?? 500).send({ error: { message: e.message } });
      }
    },
  );

  app.get(
    '/jobs',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      if (reply.sent) return;
      const q = req.query as { projectId?: string; status?: string; limit?: string };
      const jobs = await jobService.list({
        projectId: q.projectId,
        status: q.status,
        limit: q.limit ? Number(q.limit) : 50,
      });
      return { jobs };
    },
  );

  // Static path MUST be registered before /jobs/:id so "errors" is not captured as an id
  app.get(
    '/jobs/errors/search',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      if (reply.sent) return;
      const q = (req.query as { q?: string }).q ?? '';
      const errors = await jobService.searchErrors(q);
      return { errors };
    },
  );

  app.get(
    '/jobs/:id',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      if (reply.sent) return;
      const { id } = req.params as { id: string };
      // Reject non-UUID ids so static paths like "errors" never hit the DB
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return reply.code(400).send({ error: { message: 'Invalid job id' } });
      }
      const job = await jobService.getById(id);
      if (!job) return reply.code(404).send({ error: { message: 'Not found' } });
      return { job };
    },
  );

  app.patch(
    '/jobs/:id/status',
    { preHandler: [authenticate, requireExactRole('callback')] },
    async (req, reply) => {
      if (reply.sent) return;
      const { id } = req.params as { id: string };
      if (req.principal?.jobId !== id) {
        return reply.code(403).send({ error: { code: 'E015', message: 'Token not scoped to this job' } });
      }
      try {
        const body = statusSchema.parse(req.body);
        const job = await jobService.updateStatus(id, body as never, { fromCallback: true });
        return { job };
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message: string; issues?: unknown };
        if (e.issues) {
          return reply.code(400).send({ error: { message: 'Invalid body', detail: e.issues } });
        }
        return reply.code(e.statusCode ?? 500).send({
          error: { code: e.code, message: e.message },
        });
      }
    },
  );

  app.patch(
    '/jobs/:id/heartbeat',
    { preHandler: [authenticate, requireExactRole('callback')] },
    async (req, reply) => {
      if (reply.sent) return;
      const { id } = req.params as { id: string };
      if (req.principal?.jobId !== id) {
        return reply.code(403).send({ error: { code: 'E015', message: 'Token not scoped to this job' } });
      }
      const body = (req.body ?? {}) as { fencingToken?: string };
      const result = await jobService.heartbeat(id, body.fencingToken);
      if (!result.ok) return reply.code(403).send({ error: { message: 'Heartbeat rejected' } });
      return { ok: true };
    },
  );

  app.get(
    '/dead-letter',
    { preHandler: [authenticate, requireRole('operator')] },
    async (_req, reply) => {
      if (reply.sent) return;
      const items = await jobService.listDeadLetter();
      return { items };
    },
  );

  app.post(
    '/dead-letter/:jobId/retry',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req, reply) => {
      if (reply.sent) return;
      const { jobId } = req.params as { jobId: string };
      const job = await jobService.retryDeadLetter(jobId);
      return { job };
    },
  );
}
