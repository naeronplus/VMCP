import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { validateProductionEnv } from './config/production-validation.js';
import { ensureBootstrapAdmin } from './services/auth-service.js';
import { lockService } from './services/lock-service.js';
import {
  scheduleRepeatableJobs,
  startHealthWorkers,
} from './workers/health-worker.js';
import { closePool, getPool } from './db/pool.js';
import { closeRedis, getRedis } from './lib/redis.js';
import { registerWorkers, closeWorkers } from './lib/worker-manager.js';

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  const shutdown = async (signal: string, exitCode = 0) => {
    app.log.info(`Shutting down on ${signal}`);
    await closeWorkers();
    await app.close();
    await closePool();
    await closeRedis();
    process.exit(exitCode);
  };

  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await ensureBootstrapAdmin();
    const { rows: admins } = await getPool().query(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
    );
    validateProductionEnv(env, { adminExists: admins.length > 0 });
    await verifyStartupConnectivity();
    await lockService.ensureInstanceId();
    registerWorkers(startHealthWorkers());
    await scheduleRepeatableJobs();
  } catch (err) {
    if (env.NODE_ENV === 'production') {
      app.log.fatal({ err }, 'Startup dependency initialization failed');
      process.exit(1);
    }
    app.log.warn({ err }, 'Startup side-effects failed (DB/Redis may be down)');
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`PGOS orchestrator listening on ${env.HOST}:${env.PORT}`);
}

async function verifyStartupConnectivity(): Promise<void> {
  await getPool().query('SELECT 1');
  const pong = await getRedis().ping();
  if (pong !== 'PONG') {
    throw new Error(`Redis ping failed: ${pong}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});