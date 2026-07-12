import { Redis as RedisClient } from 'ioredis';
import type { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const env = getEnv();
    redis = new RedisClient(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

export const REDIS_INSTANCE_KEY = 'pgos:redis_instance_id';
