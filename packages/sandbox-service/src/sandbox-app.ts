/**
 * Fastify app factory for the sandbox service (importable without listen).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { firecrackerHealth } from './production-validation.js';
import { runIsolated, type RunIsolatedOpts } from './run-isolated.js';

export const executeSchema = z.object({
  extensionId: z.string(),
  inputs: z.record(z.unknown()).default({}),
  network: z.boolean().default(false),
  approvedDomains: z.array(z.string()).default([]),
  limits: z
    .object({
      cpu: z.number().default(1),
      memoryMiB: z.number().default(512),
      diskMiB: z.number().default(1024),
      timeoutSeconds: z.number().default(60),
    })
    .default({}),
});

export type BuildSandboxAppOptions = {
  internalToken?: string;
  /** Inject runner (tests). Defaults to runIsolated. */
  runIsolatedImpl?: (opts: RunIsolatedOpts) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
};

export function buildSandboxApp(options: BuildSandboxAppOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const internalToken = options.internalToken ?? env.SANDBOX_INTERNAL_TOKEN ?? 'dev-sandbox-token';
  const runner = options.runIsolatedImpl ?? ((opts) => runIsolated(opts, env));

  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url === '/ready') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${internalToken}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => {
    const fc = firecrackerHealth(env);
    return {
      ok: true,
      service: 'pgos-sandbox',
      backend: fc.backend,
      firecrackerReady: fc.firecrackerReady,
      firecrackerLauncherMode: fc.launcherMode,
      /** H-08: worker_thread_only | firecracker_real | firecracker_stub */
      sandboxPolicy: fc.policy,
    };
  });

  app.get('/ready', async () => {
    const fc = firecrackerHealth(env);
    return {
      ok: true,
      service: 'pgos-sandbox',
      firecrackerReady: fc.firecrackerReady,
      backend: fc.backend,
      sandboxPolicy: fc.policy,
    };
  });

  app.post('/v1/execute', async (req, reply) => {
    const body = executeSchema.parse(req.body);

    if (body.network) {
      req.log.info(
        { domains: body.approvedDomains },
        'network enabled for approved domains only',
      );
    }

    const timeoutMs = body.limits.timeoutSeconds * 1000;
    const memoryLimit = body.limits.memoryMiB * 1024 * 1024;

    try {
      const result = await runner({
        extensionId: body.extensionId,
        inputs: body.inputs,
        network: body.network,
        approvedDomains: body.approvedDomains,
        timeoutMs,
        memoryLimit,
      });
      return { ok: true, result, limits: body.limits };
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('timeout') || message.includes('TIMEOUT')) {
        return reply.code(504).send({
          ok: false,
          error: 'EXTENSION_EXEC_TIMEOUT',
          code: 'E009',
          message,
        });
      }
      if (message.includes('NETWORK_DENIED')) {
        return reply.code(403).send({
          ok: false,
          error: 'EXTENSION_NETWORK_DENIED',
          code: 'E016',
          message,
        });
      }
      if (message.includes('MEMORY_LIMIT') || /heap|ERR_WORKER_OUT_OF_MEMORY/i.test(message)) {
        return reply.code(500).send({
          ok: false,
          error: 'EXTENSION_MEMORY_LIMIT',
          code: 'E009',
          message,
        });
      }
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  return app;
}
