import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  formatFencingToken,
  parseFencingToken,
  type ActiveLock,
  type LockFencingEntry,
} from '@vibrato/shared';
import { getRedis, REDIS_INSTANCE_KEY } from '../lib/redis.js';
import { getPool, withTransaction } from '../db/pool.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sentinel lock_key always written on Redis instance rotation (M-17).
 * Guarantees a FAILOVER ledger row even when no pg_locks are active.
 * Not used for normal acquire/release — audit + history only.
 */
export const FAILOVER_SENTINEL_LOCK_KEY = 'pgos:system:redis-failover';

export type FailoverLedgerRow = {
  lockKey: string;
  owner: string;
  token: string;
  instanceId: string;
  reason: 'FAILOVER';
};

/**
 * Build FAILOVER ledger rows for rotateInstanceIdOnFailover (pure, testable).
 * - One row per active lock_key (so validateFencingToken sees latest.reason=FAILOVER)
 * - Always includes the sentinel key for a durable audit trail
 */
export function buildFailoverLedgerRows(opts: {
  newInstanceId: string;
  activeLockKeys: string[];
}): FailoverLedgerRow[] {
  const token = formatFencingToken(opts.newInstanceId, 0);
  const keys = new Set<string>(opts.activeLockKeys.filter(Boolean));
  keys.add(FAILOVER_SENTINEL_LOCK_KEY);
  return [...keys].sort().map((lockKey) => ({
    lockKey,
    owner: 'system',
    token,
    instanceId: opts.newInstanceId,
    reason: 'FAILOVER' as const,
  }));
}

function loadLua(name: string): string {
  const candidates = [
    path.join(__dir, '../lua', name),
    path.join(__dir, '../../src/lua', name),
    path.join(process.cwd(), 'src/lua', name),
    path.join(process.cwd(), 'packages/orchestrator/src/lua', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  throw new Error(`Lua script not found: ${name}`);
}

export type AcquireResult =
  | { status: 'acquired' | 'reentrant'; token: string }
  | { status: 'denied' }
  | { status: 'error'; message: string };

export class LockService {
  private acquireSha: string | null = null;
  private releaseSha: string | null = null;
  private bumpSha: string | null = null;
  private instanceId: string | null = null;

  async ensureInstanceId(): Promise<string> {
    if (this.instanceId) return this.instanceId;
    const redis = getRedis();
    let id = await redis.get(REDIS_INSTANCE_KEY);
    if (!id) {
      // Bootstrap: prefer Postgres singleton, else new UUID
      const pool = getPool();
      const { rows } = await pool.query<{ instance_id: string }>(
        'SELECT instance_id::text FROM redis_instance_state WHERE id = 1',
      );
      id = rows[0]?.instance_id ?? randomUUID();
      const set = await redis.set(REDIS_INSTANCE_KEY, id, 'NX');
      if (set !== 'OK') {
        id = (await redis.get(REDIS_INSTANCE_KEY)) ?? id;
      } else {
        await pool.query(
          `INSERT INTO redis_instance_state (id, instance_id, updated_at)
           VALUES (1, $1::uuid, now())
           ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id, updated_at = now()`,
          [id],
        );
      }
    }
    this.instanceId = id;
    return id;
  }

  /**
   * Called by health checker after Redis failover detection.
   * Rotates instanceId so old fencing tokens are rejected.
   *
   * M-17: also INSERT lock_fencing_seq rows with reason='FAILOVER' for every
   * active lock_key (+ sentinel) so validateFencingToken sees FAILOVER on the
   * latest ledger row (not only instance_id mismatch).
   */
  async rotateInstanceIdOnFailover(): Promise<string> {
    const redis = getRedis();
    const previousInstanceId = this.instanceId ?? (await redis.get(REDIS_INSTANCE_KEY));
    const newId = randomUUID();

    // Active generation locks that must be invalidated at the ledger layer
    const { rows: activeLocks } = await getPool().query<{ lock_key: string }>(
      `SELECT lock_key FROM pg_locks`,
    );
    const activeKeys = activeLocks.map((r) => r.lock_key);
    const ledgerRows = buildFailoverLedgerRows({
      newInstanceId: newId,
      activeLockKeys: activeKeys,
    });

    await withTransaction(async (client) => {
      // 1) Point Postgres singleton at the new Redis master id
      await client.query(
        `INSERT INTO redis_instance_state (id, instance_id, updated_at)
         VALUES (1, $1::uuid, now())
         ON CONFLICT (id) DO UPDATE
           SET instance_id = EXCLUDED.instance_id, updated_at = now()`,
        [newId],
      );

      // 2) FAILOVER ledger rows — visible to validateFencingToken (latest.reason)
      for (const row of ledgerRows) {
        await client.query(
          `INSERT INTO lock_fencing_seq (lock_key, owner, token, instance_id, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.lockKey, row.owner, row.token, row.instanceId, row.reason],
        );
      }

      // 3) Soft bookkeeping: clear pg_locks (same as reclaim — holders must re-acquire)
      if (activeKeys.length > 0) {
        await client.query(`DELETE FROM pg_locks`);
      }

      await client.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, detail)
         VALUES (NULL, NULL, $1, 'redis', $2, $3)`,
        [
          'redis.failover_instance_rotated',
          newId,
          JSON.stringify({
            reason: 'FAILOVER',
            previousInstanceId,
            newInstanceId: newId,
            failoverLockKeys: ledgerRows.map((r) => r.lockKey),
            activeLocksInvalidated: activeKeys.length,
          }),
        ],
      );
    });

    // Redis after Postgres commit so a failed txn does not leave split-brain id
    await redis.set(REDIS_INSTANCE_KEY, newId);
    this.instanceId = newId;

    return newId;
  }

  private async loadScripts(): Promise<void> {
    const redis = getRedis();
    if (!this.acquireSha) {
      this.acquireSha = (await redis.script('LOAD', loadLua('acquire_lock.lua'))) as string;
    }
    if (!this.releaseSha) {
      this.releaseSha = (await redis.script('LOAD', loadLua('release_lock.lua'))) as string;
    }
    if (!this.bumpSha) {
      this.bumpSha = (await redis.script('LOAD', loadLua('bump_fencing.lua'))) as string;
    }
  }

  /**
   * Acquire lock: Redis Lua first, then double-write token to Postgres ledger
   * in the same transaction as the audit log. On Postgres failure, release Redis.
   */
  async acquire(
    lockKey: string,
    ownerId: string,
    ttlSeconds: number,
    opts?: { jobId?: string; reason?: 'ACQUIRED' | 'REENTRANT' },
  ): Promise<AcquireResult> {
    await this.ensureInstanceId();
    await this.loadScripts();
    const redis = getRedis();

    const raw = (await redis.evalsha(
      this.acquireSha!,
      1,
      lockKey,
      ownerId,
      String(ttlSeconds),
      REDIS_INSTANCE_KEY,
    )) as [number | string, string];

    const statusCode = Number(raw[0]);
    const token = String(raw[1]);

    if (statusCode === -1) {
      return { status: 'error', message: token };
    }
    if (statusCode === 0) {
      return { status: 'denied' };
    }

    const status = statusCode === 1 ? 'acquired' : 'reentrant';
    const reason = opts?.reason ?? (status === 'acquired' ? 'ACQUIRED' : 'REENTRANT');
    const parsed = parseFencingToken(token);
    const instanceId = parsed?.instanceId ?? (await this.ensureInstanceId());

    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO lock_fencing_seq (lock_key, owner, token, instance_id, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [lockKey, ownerId, token, instanceId, reason],
        );
        await client.query(
          `INSERT INTO pg_locks (lock_key, owner_id, fencing_token, job_id, last_heartbeat_at, acquired_at, ttl_seconds)
           VALUES ($1, $2, $3, $4, now(), now(), $5)
           ON CONFLICT (lock_key) DO UPDATE SET
             owner_id = EXCLUDED.owner_id,
             fencing_token = EXCLUDED.fencing_token,
             job_id = COALESCE(EXCLUDED.job_id, pg_locks.job_id),
             last_heartbeat_at = now(),
             ttl_seconds = EXCLUDED.ttl_seconds`,
          [lockKey, ownerId, token, opts?.jobId ?? null, ttlSeconds],
        );
        await client.query(
          `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, detail)
           VALUES (NULL, NULL, $1, 'lock', $2, $3)`,
          [
            status === 'acquired' ? 'lock.acquired' : 'lock.reentrant',
            lockKey,
            JSON.stringify({ ownerId, token, jobId: opts?.jobId }),
          ],
        );
      });
    } catch (err) {
      // Postgres write failed → release Redis lock and surface for retry
      await this.releaseRedisOnly(lockKey, ownerId);
      throw err;
    }

    return { status, token };
  }

  private async releaseRedisOnly(lockKey: string, ownerId: string): Promise<void> {
    await this.loadScripts();
    const redis = getRedis();
    await redis.evalsha(this.releaseSha!, 1, lockKey, ownerId);
  }

  async release(lockKey: string, ownerId: string): Promise<boolean> {
    await this.loadScripts();
    const redis = getRedis();
    const n = Number(await redis.evalsha(this.releaseSha!, 1, lockKey, ownerId));
    if (n === 1) {
      await getPool().query(
        `UPDATE lock_fencing_seq SET released_at = now()
         WHERE lock_key = $1 AND owner = $2 AND released_at IS NULL`,
        [lockKey, ownerId],
      );
      await getPool().query(`DELETE FROM pg_locks WHERE lock_key = $1 AND owner_id = $2`, [
        lockKey,
        ownerId,
      ]);
    }
    return n === 1;
  }

  /**
   * Stale recovery / admin reclaim: bump fencing token, ledger row, release lock.
   */
  async reclaim(
    lockKey: string,
    reason: 'STALE_RECOVERED' | 'ADMIN_RECLAIM',
    adminIdentity?: string,
  ): Promise<{ token: string }> {
    await this.ensureInstanceId();
    await this.loadScripts();
    const redis = getRedis();
    const raw = (await redis.evalsha(
      this.bumpSha!,
      1,
      lockKey,
      REDIS_INSTANCE_KEY,
    )) as [number | string, string];

    if (Number(raw[0]) !== 1) {
      throw new Error(`Failed to bump fencing token: ${raw[1]}`);
    }
    const token = String(raw[1]);
    const parsed = parseFencingToken(token);
    const instanceId = parsed?.instanceId ?? (await this.ensureInstanceId());

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO lock_fencing_seq (lock_key, owner, token, instance_id, reason, admin_identity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lockKey, 'system', token, instanceId, reason, adminIdentity ?? null],
      );
      await client.query(`DELETE FROM pg_locks WHERE lock_key = $1`, [lockKey]);
      await client.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, detail)
         VALUES (NULL, $1, $2, 'lock', $3, $4)`,
        [
          adminIdentity ? 'admin' : null,
          reason === 'ADMIN_RECLAIM' ? 'lock.admin_reclaim' : 'lock.stale_recovered',
          lockKey,
          JSON.stringify({ token, reason, adminIdentity }),
        ],
      );
    });

    return { token };
  }

  /**
   * Commit validation (§3.1 / §3.3):
   * - Latest ledger row for the lock_key is authoritative (any owner).
   * - After STALE_RECOVERED / ADMIN_RECLAIM / FAILOVER the latest owner is
   *   "system", so workers holding the previous owner token are rejected (403).
   * - Presented token must match latest token, owner must match, and
   *   instanceId must match the current Redis master.
   */
  async validateFencingToken(
    lockKey: string,
    owner: string,
    presentedToken: string,
    client?: PoolClient,
  ): Promise<boolean> {
    const q = client ?? getPool();
    const { rows } = await q.query<{
      token: string;
      instance_id: string;
      owner: string;
      reason: string;
    }>(
      `SELECT token, instance_id, owner, reason FROM lock_fencing_seq
       WHERE lock_key = $1
       ORDER BY acquired_at DESC LIMIT 1`,
      [lockKey],
    );
    if (rows.length === 0) return false;
    const latest = rows[0]!;
    const currentInstance = await this.ensureInstanceId();
    if (latest.instance_id.toLowerCase() !== currentInstance.toLowerCase()) {
      return false;
    }
    // Reclaim / failover invalidates every prior holder
    if (
      latest.reason === 'STALE_RECOVERED' ||
      latest.reason === 'ADMIN_RECLAIM' ||
      latest.reason === 'FAILOVER'
    ) {
      return false;
    }
    if (latest.owner !== owner) return false;
    return latest.token === presentedToken;
  }

  async listActiveLocks(): Promise<ActiveLock[]> {
    const redis = getRedis();
    const { rows } = await getPool().query<{
      lock_key: string;
      owner_id: string;
      fencing_token: string;
      last_heartbeat_at: Date;
      ttl_seconds: number;
    }>(`SELECT * FROM pg_locks ORDER BY acquired_at DESC`);

    const result: ActiveLock[] = [];
    for (const row of rows) {
      const redisOwner = await redis.get(row.lock_key);
      const ttl = await redis.ttl(row.lock_key);
      const history = await this.getHistory(row.lock_key);
      let health: ActiveLock['health'] = 'unknown';
      if (!redisOwner) health = 'stale';
      else if (redisOwner === row.owner_id) health = 'healthy';
      else health = 'stale';

      result.push({
        lockKey: row.lock_key,
        ownerId: row.owner_id,
        fencingToken: row.fencing_token,
        health,
        ttlSeconds: ttl > 0 ? ttl : row.ttl_seconds,
        history,
      });
    }
    return result;
  }

  async getHistory(lockKey: string, limit = 50): Promise<LockFencingEntry[]> {
    const { rows } = await getPool().query(
      `SELECT id, lock_key, owner, token, instance_id, reason,
              acquired_at, released_at, admin_identity
       FROM lock_fencing_seq WHERE lock_key = $1
       ORDER BY acquired_at DESC LIMIT $2`,
      [lockKey, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      lockKey: r.lock_key,
      owner: r.owner,
      token: r.token,
      instanceId: r.instance_id,
      reason: r.reason,
      acquiredAt: new Date(r.acquired_at).toISOString(),
      releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
      adminIdentity: r.admin_identity,
    }));
  }

  generationLockKey(projectId: string): string {
    return `project:${projectId}:generation`;
  }

  targetPathLockKey(projectId: string): string {
    return `project:${projectId}:target-path`;
  }
}

export const lockService = new LockService();
