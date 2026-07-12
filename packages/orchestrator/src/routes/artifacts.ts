import type { FastifyInstance } from 'fastify';
import { assertArtifactKey, assertArtifactKeyForJob, PathTraversalError } from '@vibrato/shared';
import { authenticate, requireRole } from '../middleware/auth.js';
import { s3Service } from '../services/s3-service.js';
import { jobService } from '../services/job-service.js';

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/artifacts/presign',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const q = req.query as { key: string; method?: 'get' | 'put' };
      if (!q.key) {
        return reply.code(400).send({ error: { code: 'E014', message: 'key query param required' } });
      }
      try {
        let key = assertArtifactKey(q.key);
        if (req.principal?.kind === 'callback' && req.principal.jobId) {
          const job = await jobService.getById(req.principal.jobId);
          if (!job) {
            return reply.code(404).send({ error: { message: 'Job not found' } });
          }
          key = assertArtifactKeyForJob(key, job.projectId, req.principal.jobId);
        }
        const url =
          q.method === 'put'
            ? await s3Service.presignPut(key)
            : await s3Service.presignGet(key);
        return { url };
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // Local memory-store fallback for dev without MinIO
  app.put(
    '/artifacts/local-upload/:key',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const key = decodeURIComponent((req.params as { key: string }).key);
      try {
        assertArtifactKey(key);
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
      const buf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body ?? {}));
      await s3Service.putObject(key, buf);
      return { ok: true, key };
    },
  );

  app.get(
    '/artifacts/local/:key',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      const key = decodeURIComponent((req.params as { key: string }).key);
      try {
        assertArtifactKey(key);
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
      const data = await s3Service.getObject(key);
      if (!data) return reply.code(404).send({ error: { message: 'Not found' } });
      return reply.send(data);
    },
  );
}
