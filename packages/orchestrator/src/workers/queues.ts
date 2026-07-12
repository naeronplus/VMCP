import { Queue, type ConnectionOptions } from 'bullmq';
import { getEnv } from '../config/env.js';

function connection(): ConnectionOptions {
  const raw = getEnv().REDIS_URL;
  // Support redis:// and rediss://
  const url = new URL(raw);
  const port = url.port ? Number(url.port) : url.protocol === 'rediss:' ? 6380 : 6379;
  const opts: ConnectionOptions = {
    host: url.hostname || '127.0.0.1',
    port,
    maxRetriesPerRequest: null,
  };
  if (url.password) opts.password = decodeURIComponent(url.password);
  if (url.username && url.username !== 'default') {
    opts.username = decodeURIComponent(url.username);
  } else if (url.username === 'default' && url.password) {
    // Redis 6 ACL default user
    opts.username = 'default';
    opts.password = decodeURIComponent(url.password);
  }
  if (url.protocol === 'rediss:') {
    (opts as { tls?: object }).tls = {};
  }
  // db index from path /0
  const dbMatch = url.pathname?.match(/^\/(\d+)$/);
  if (dbMatch) {
    (opts as { db?: number }).db = Number(dbMatch[1]);
  }
  return opts;
}

export const dispatchQueue = new Queue('pgos-dispatch', { connection: connection() });
export const healthQueue = new Queue('pgos-health', { connection: connection() });
export const deadLetterQueue = new Queue('pgos-dead-letter', { connection: connection() });
export const uidReconcileQueue = new Queue('pgos-uid-reconcile', { connection: connection() });
export const secretRotationQueue = new Queue('pgos-secret-rotation', {
  connection: connection(),
});
export const parityQueue = new Queue('pgos-parity', { connection: connection() });

export function queueConnection(): ConnectionOptions {
  return connection();
}
