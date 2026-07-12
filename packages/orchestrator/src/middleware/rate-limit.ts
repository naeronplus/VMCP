import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../lib/redis.js';
import { getEnv } from '../config/env.js';

let rateLimitSha: string | null = null;

function loadLua(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, '../lua/rate_limit.lua'),
    path.join(dir, '../../src/lua/rate_limit.lua'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  return `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= max then return {0, count} end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1}
`;
}

/**
 * Per-user / per-token sliding window rate limit (§9.3).
 */
export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return;
  if (
    request.url.startsWith('/health') ||
    request.url.startsWith('/ready') ||
    request.url.startsWith('/assets')
  ) {
    return;
  }

  const env = getEnv();
  try {
    const redis = getRedis();
    if (!rateLimitSha) {
      rateLimitSha = (await redis.script('LOAD', loadLua())) as string;
    }
    const identity = request.principal?.jti ?? request.ip ?? 'anon';
    const key = `pgos:ratelimit:${identity}`;
    const now = Date.now();
    const member = randomUUID();
    const sustained = (await redis.evalsha(
      rateLimitSha,
      1,
      key,
      String(60_000),
      String(env.RATE_LIMIT_PER_MINUTE),
      String(now),
      member,
    )) as [number, number];

    const burstKey = `${key}:burst`;
    const burst = (await redis.evalsha(
      rateLimitSha,
      1,
      burstKey,
      String(10_000),
      String(env.RATE_LIMIT_BURST),
      String(now),
      member,
    )) as [number, number];

    if (Number(sustained[0]) === 0 || Number(burst[0]) === 0) {
      return reply.code(429).send({
        error: {
          code: 'E018',
          message: 'Rate limit exceeded',
          operatorAction: 'Back off and retry after the rate-limit window.',
          docsUrl: '/api/v1/docs/errors/E018',
        },
      });
    }
  } catch (err) {
    if (env.NODE_ENV === 'production') {
      request.log?.error?.({ err }, 'rate limit check failed; rejecting request');
      return reply.code(503).send({
        error: {
          code: 'E018',
          message: 'Rate limiting unavailable — request rejected',
        },
      });
    }
    request.log?.warn?.({ err }, 'rate limit check failed; allowing request (dev)');
  }
}

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;

/**
 * IP-based brute-force protection for /auth/login.
 */
export async function loginRateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return;
  const env = getEnv();
  try {
    const redis = getRedis();
    if (!rateLimitSha) {
      rateLimitSha = (await redis.script('LOAD', loadLua())) as string;
    }
    const key = `pgos:ratelimit:login:${request.ip ?? 'anon'}`;
    const now = Date.now();
    const raw = (await redis.evalsha(
      rateLimitSha,
      1,
      key,
      String(LOGIN_WINDOW_MS),
      String(LOGIN_LIMIT),
      String(now),
      randomUUID(),
    )) as [number, number];

    if (Number(raw[0]) === 0) {
      return reply.code(429).send({
        error: {
          code: 'E018',
          message: 'Too many login attempts — try again later',
        },
      });
    }
  } catch (err) {
    if (env.NODE_ENV === 'production') {
      request.log?.error?.({ err }, 'login rate limit check failed');
      return reply.code(503).send({
        error: { code: 'E018', message: 'Login temporarily unavailable' },
      });
    }
  }
}
