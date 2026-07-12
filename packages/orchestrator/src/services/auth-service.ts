import fs from 'node:fs';
import crypto from 'node:crypto';
import * as jose from 'jose';
import type { Role } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { getRedis } from '../lib/redis.js';
import { audit } from './audit-service.js';

const REVOCATION_REDIS_PREFIX = 'pgos:revoked:';
const SESSION_REDIS_PREFIX = 'pgos:session:';

export interface AuthPrincipal {
  userId: string;
  role: Role;
  jti: string;
  email?: string;
  kind: 'api_token' | 'session' | 'callback';
  jobId?: string;
}

let privateKey: jose.KeyLike | crypto.KeyObject | Uint8Array | null = null;
let publicKey: jose.KeyLike | crypto.KeyObject | Uint8Array | null = null;
let devSecret: Uint8Array | null = null;

async function getKeys(): Promise<{
  privateKey: jose.KeyLike | crypto.KeyObject | Uint8Array;
  publicKey: jose.KeyLike | crypto.KeyObject | Uint8Array;
  alg: 'RS256' | 'HS256';
}> {
  const env = getEnv();
  if (privateKey && publicKey) {
    return { privateKey, publicKey, alg: 'RS256' };
  }

  let privPem = env.JWT_PRIVATE_KEY;
  let pubPem = env.JWT_PUBLIC_KEY;

  if (!privPem && env.JWT_PRIVATE_KEY_PATH && fs.existsSync(env.JWT_PRIVATE_KEY_PATH)) {
    privPem = fs.readFileSync(env.JWT_PRIVATE_KEY_PATH, 'utf8');
  }
  if (!pubPem && env.JWT_PUBLIC_KEY_PATH && fs.existsSync(env.JWT_PUBLIC_KEY_PATH)) {
    pubPem = fs.readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8');
  }

  if (privPem && pubPem) {
    privateKey = await jose.importPKCS8(privPem.replace(/\\n/g, '\n'), 'RS256');
    publicKey = await jose.importSPKI(pubPem.replace(/\\n/g, '\n'), 'RS256');
    return { privateKey, publicKey, alg: 'RS256' };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'RS256 JWT keys are required in production (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY)',
    );
  }

  // Dev/test fallback: HS256 with JWE_SECRET
  if (!devSecret) {
    devSecret = new TextEncoder().encode(env.JWE_SECRET.padEnd(32, '!'));
  }
  return { privateKey: devSecret, publicKey: devSecret, alg: 'HS256' };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function issueApiToken(opts: {
  userId: string;
  role: Role;
  name: string;
  expiresInSeconds?: number;
}): Promise<{ token: string; jti: string; id: string }> {
  const env = getEnv();
  const { privateKey: key, alg } = await getKeys();
  const jti = crypto.randomUUID();
  const expiresIn = opts.expiresInSeconds ?? 90 * 24 * 3600;

  const token = await new jose.SignJWT({
    role: opts.role,
    kind: 'api_token',
  })
    .setProtectedHeader({ alg })
    .setSubject(opts.userId)
    .setJti(jti)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(key);

  const { rows } = await getPool().query(
    `INSERT INTO api_tokens (jti, name, role, user_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING id`,
    [jti, opts.name, opts.role, opts.userId, String(expiresIn)],
  );

  return { token, jti, id: rows[0].id };
}

export async function revokeToken(jti: string, reason?: string): Promise<void> {
  await getPool().query(
    `INSERT INTO token_revocations (jti, reason) VALUES ($1, $2)
     ON CONFLICT (jti) DO UPDATE SET revoked_at = now(), reason = EXCLUDED.reason`,
    [jti, reason ?? null],
  );
  await getPool().query(
    `UPDATE api_tokens SET revoked_at = now() WHERE jti = $1`,
    [jti],
  );
  // Immediate revocation via Redis (§9.2)
  await getRedis().set(`${REVOCATION_REDIS_PREFIX}${jti}`, '1', 'EX', 3600);
  await audit({
    action: 'token.revoked',
    resourceType: 'api_token',
    resourceId: jti,
    detail: { reason },
  });
}

async function isRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  const cached = await redis.get(`${REVOCATION_REDIS_PREFIX}${jti}`);
  if (cached === '1') return true;
  if (cached === '0') return false;

  const { rows } = await getPool().query(
    `SELECT 1 FROM token_revocations WHERE jti = $1
     UNION ALL
     SELECT 1 FROM api_tokens WHERE jti = $1 AND revoked_at IS NOT NULL
     LIMIT 1`,
    [jti],
  );
  const revoked = rows.length > 0;
  await redis.set(`${REVOCATION_REDIS_PREFIX}${jti}`, revoked ? '1' : '0', 'EX', 3600);
  return revoked;
}

export async function verifyBearer(token: string): Promise<AuthPrincipal | null> {
  const env = getEnv();
  try {
    const { publicKey: key } = await getKeys();
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const jti = payload.jti;
    if (!jti || !payload.sub) return null;
    if (await isRevoked(jti)) return null;

    return {
      userId: payload.sub,
      role: (payload.role as Role) ?? 'viewer',
      jti,
      kind: (payload.kind as AuthPrincipal['kind']) ?? 'api_token',
      jobId: payload.jobId as string | undefined,
    };
  } catch {
    return null;
  }
}

export async function createSession(userId: string): Promise<string> {
  const env = getEnv();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
  await getPool().query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [id, userId, expiresAt.toISOString()],
  );
  await getRedis().set(
    `${SESSION_REDIS_PREFIX}${id}`,
    userId,
    'EX',
    env.SESSION_TTL_SECONDS,
  );
  return id;
}

export async function destroySession(sessionId: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  await getRedis().del(`${SESSION_REDIS_PREFIX}${sessionId}`);
}

export async function resolveSession(sessionId: string): Promise<AuthPrincipal | null> {
  const redis = getRedis();
  let userId = await redis.get(`${SESSION_REDIS_PREFIX}${sessionId}`);
  if (!userId) {
    const { rows } = await getPool().query(
      `SELECT user_id FROM sessions WHERE id = $1 AND expires_at > now()`,
      [sessionId],
    );
    if (rows.length === 0) return null;
    userId = rows[0].user_id;
    const env = getEnv();
    await redis.set(
      `${SESSION_REDIS_PREFIX}${sessionId}`,
      userId!,
      'EX',
      env.SESSION_TTL_SECONDS,
    );
  }
  const { rows } = await getPool().query(
    `SELECT id, role, email FROM users WHERE id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].id,
    role: rows[0].role,
    email: rows[0].email,
    jti: `session:${sessionId}`,
    kind: 'session',
  };
}

export function mintCallbackToken(jobId: string): {
  token: string;
  hash: string;
  expiresAt: Date;
} {
  const env = getEnv();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.CALLBACK_TOKEN_TTL_MS);
  // Bind job id so token is scoped
  const scoped = `${jobId}.${token}`;
  return { token: scoped, hash: hashToken(scoped), expiresAt };
}

export function parseCallbackToken(raw: string): { jobId: string; token: string } | null {
  const idx = raw.indexOf('.');
  if (idx <= 0) return null;
  return { jobId: raw.slice(0, idx), token: raw.slice(idx + 1) };
}

/** scrypt password hash: scrypt$N$r$p$saltB64$hashB64 (also accepts legacy sha256 hex). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
  }
  // Legacy bootstrap hashes (sha256 hex) — still accepted for migration
  const legacy = crypto.createHash('sha256').update(password).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
  } catch {
    return legacy === stored;
  }
}

export async function ensureBootstrapAdmin(): Promise<void> {
  const env = getEnv();
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (rows.length > 0) return;

  const password =
    env.BOOTSTRAP_ADMIN_PASSWORD ||
    (env.NODE_ENV === 'production' ? '' : 'admin-change-me');

  if (!password) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'No admin user exists and BOOTSTRAP_ADMIN_PASSWORD is not set',
      );
    }
    return;
  }

  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  const hash = hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, display_name, role, password_hash)
     VALUES ($1, 'Bootstrap Admin', 'admin', $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, hash],
  );
}

export async function authenticatePassword(
  email: string,
  password: string,
): Promise<{ id: string; role: Role; email: string } | null> {
  const { rows } = await getPool().query(
    `SELECT id, role, email, password_hash FROM users WHERE email = $1`,
    [email],
  );
  if (rows.length === 0 || !rows[0].password_hash) return null;
  if (!verifyPassword(password, rows[0].password_hash)) return null;
  return { id: rows[0].id, role: rows[0].role, email: rows[0].email };
}
