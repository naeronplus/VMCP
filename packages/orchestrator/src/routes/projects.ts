import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getPool } from '../db/pool.js';
import { uidService } from '../services/uid-service.js';
import { baselineService } from '../services/baseline-service.js';
import { PathTraversalError } from '@vibrato/shared';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/projects',
    { preHandler: [authenticate, requireRole('viewer')] },
    async () => {
      const { rows } = await getPool().query(
        `SELECT * FROM projects ORDER BY created_at DESC`,
      );
      return { projects: rows };
    },
  );

  app.post(
    '/projects',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1),
          slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
          godotVersion: z.string().default('4.3.1'),
          projectRoot: z.string().min(1),
          highVolume: z.boolean().optional(),
          adminContacts: z.array(z.string().email()).optional(),
        })
        .parse(req.body);

      const { rows } = await getPool().query(
        `INSERT INTO projects (name, slug, godot_version, project_root, high_volume, admin_contacts)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          body.name,
          body.slug,
          body.godotVersion,
          body.projectRoot,
          body.highVolume ?? false,
          body.adminContacts ?? [],
        ],
      );
      return reply.code(201).send({ project: rows[0] });
    },
  );

  app.get(
    '/projects/:id',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { rows } = await getPool().query(`SELECT * FROM projects WHERE id = $1`, [id]);
      if (!rows[0]) return reply.code(404).send({ error: { message: 'Not found' } });
      return { project: rows[0] };
    },
  );

  app.post(
    '/projects/:id/uid-reservations',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          logicalAssetPath: z.string().min(1),
          namespace: z.enum(['GEN-', 'OVRD-']).optional(),
          jobId: z.string().uuid().optional(),
        })
        .parse(req.body);
      try {
        const reservation = await uidService.reserve({
          projectId: id,
          logicalAssetPath: body.logicalAssetPath,
          namespace: body.namespace,
          jobId: body.jobId,
        });
        return reply.code(201).send({ reservation });
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({
            error: { code: 'E014', message: err.message },
          });
        }
        return reply.code(409).send({
          error: { message: (err as Error).message },
        });
      }
    },
  );

  app.post(
    '/projects/:id/uid-reservations/commit',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const body = z
        .object({
          reservationId: z.string().uuid(),
          finalUid: z.string().min(1),
          namespace: z.enum(['GEN-', 'OVRD-', 'USER-']).optional(),
        })
        .parse(req.body);
      const { id } = req.params as { id: string };
      try {
        await uidService.commitReservation({ projectId: id, ...body });
        return { ok: true };
      } catch (err) {
        const e = err as { statusCode?: number; message: string };
        return reply.code(e.statusCode ?? 500).send({ error: { message: e.message } });
      }
    },
  );

  app.get(
    '/projects/:id/uids',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const mappings = await uidService.listForProject(id);
      return { mappings };
    },
  );

  app.get(
    '/projects/:id/baselines',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const baselines = await baselineService.listForProject(id);
      return { baselines };
    },
  );

  app.get(
    '/projects/:id/baselines/latest',
    { preHandler: [authenticate, requireRole('viewer')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const baseline = await baselineService.getLatest(id);
      if (!baseline) {
        return reply.code(404).send({ error: { message: 'No baseline recorded' } });
      }
      return { baseline };
    },
  );

  app.post(
    '/projects/:id/baselines',
    { preHandler: [authenticate, requireRole('operator')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          s3Key: z.string().min(1),
          checksum: z.string().min(1),
        })
        .parse(req.body);
      const baseline = await baselineService.create({
        projectId: id,
        s3Key: body.s3Key,
        checksum: body.checksum,
        actorId: req.principal?.userId,
      });
      return reply.code(201).send({ baseline });
    },
  );

  app.post(
    '/projects/:id/uids/reconcile',
    { preHandler: [authenticate, requireRole('admin')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { rows } = await getPool().query(
        `SELECT project_root FROM projects WHERE id = $1`,
        [id],
      );
      const result = await uidService.autoResolveDuplicates(id, {
        projectRoot: rows[0]?.project_root
          ? String(rows[0].project_root)
          : undefined,
        runGodot: true,
      });
      return { result };
    },
  );
}
