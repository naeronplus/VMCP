import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEnv } from './config/env.js';
import { jobRoutes } from './routes/jobs.js';
import { lockRoutes } from './routes/locks.js';
import { projectRoutes } from './routes/projects.js';
import { authRoutes } from './routes/auth.js';
import { secretRoutes } from './routes/secrets.js';
import { extensionRoutes } from './routes/extensions.js';
import { mergeRoutes } from './routes/merge.js';
import { adminRoutes } from './routes/admin.js';
import { artifactRoutes } from './routes/artifacts.js';
import { initWsHub } from './lib/ws-hub.js';
import { authenticate } from './middleware/auth.js';
import { rateLimitHook } from './middleware/rate-limit.js';

export async function buildApp() {
  const env = getEnv();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
    bodyLimit: 10 * 1024 * 1024,
  });

  const corsOrigins = resolveCorsOrigins(env);
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    const e = err as {
      statusCode?: number;
      code?: string;
      message: string;
      validation?: unknown;
      issues?: unknown;
    };
    if (e.issues || e.validation) {
      return reply.code(400).send({
        error: { message: 'Validation failed', detail: e.issues ?? e.validation },
      });
    }
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      _req.log.error(err);
    }
    const env = getEnv();
    const clientMessage =
      status >= 500 && env.NODE_ENV === 'production'
        ? 'Internal Server Error'
        : e.message || 'Internal Server Error';
    return reply.code(status).send({
      error: {
        code: e.code,
        message: clientMessage,
      },
    });
  });

  const hub = initWsHub();

  app.get('/health', async () => ({
    ok: true,
    service: 'pgos-orchestrator',
    mcpName: 'Vibrato',
    ts: new Date().toISOString(),
  }));

  // M-09: Railway healthcheckPath must be /ready (not /health).
  // /health is liveness only; /ready fails with 503 when Postgres or Redis is down.
  app.get('/ready', async (_req, reply) => {
    const { checkLiveReadiness } = await import('./services/readiness.js');
    const result = await checkLiveReadiness();
    if (!result.ok) {
      return reply.code(result.statusCode).send({
        ok: false,
        error: result.error,
      });
    }
    return { ok: true };
  });

  // Real-time job status WebSocket (§2.1)
  app.get(
    '/ws',
    {
      websocket: true,
      preHandler: async (req, reply) => {
        await authenticate(req, reply);
        if (reply.sent) {
          // Ensure unauthorized upgrade attempts do not stay open
          return reply;
        }
      },
    },
    (socket, req) => {
      const principal = req.principal;
      hub.add(socket, {
        role: principal?.role ?? 'viewer',
        projectIds: new Set(),
      });
      socket.send(
        JSON.stringify({
          type: 'alert',
          payload: {
            message: 'connected',
            hint: 'Send {"type":"subscribe","projectIds":["<uuid>"]} to filter events',
          },
          at: new Date().toISOString(),
        }),
      );
    },
  );

  await app.register(
    async (api) => {
      api.addHook('preHandler', async (req, reply) => {
        await rateLimitHook(req, reply);
      });
      await api.register(authRoutes);
      await api.register(jobRoutes);
      await api.register(lockRoutes);
      await api.register(projectRoutes);
      await api.register(secretRoutes);
      await api.register(extensionRoutes);
      await api.register(mergeRoutes);
      await api.register(adminRoutes);
      await api.register(artifactRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Serve React dashboard from same process (§2.1, §9.4)
  const dashboardDist = resolveDashboardDist();
  if (dashboardDist) {
    await app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: { message: 'Not found' } });
      }
      const index = path.join(dashboardDist, 'index.html');
      if (fs.existsSync(index)) {
        return reply.type('text/html').send(fs.readFileSync(index, 'utf8'));
      }
      return reply.code(404).send({ error: { message: 'Not found' } });
    });
  }

  return app;
}

function resolveCorsOrigins(env: ReturnType<typeof getEnv>): boolean | string[] {
  if (env.NODE_ENV !== 'production') {
    return true;
  }
  const raw = env.CORS_ALLOWED_ORIGINS.trim();
  const origins = raw
    ? raw.split(',').map((o) => o.trim()).filter(Boolean)
    : [env.PUBLIC_BASE_URL];
  return origins;
}

function resolveDashboardDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../dashboard/dist'),
    path.resolve(process.cwd(), 'packages/dashboard/dist'),
    path.resolve(process.cwd(), '../dashboard/dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}
