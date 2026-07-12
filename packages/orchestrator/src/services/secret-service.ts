import crypto from 'node:crypto';
import * as jose from 'jose';
import type { SecretEnvelope } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { hashToken } from './auth-service.js';

/**
 * JWE + reference exchange for sensitive worker inputs (§9.4).
 * Dispatch carries a single dispatch JWE; callback credential is embedded inside
 * (never passed as a GitHub workflow_dispatch input).
 */
export class SecretService {
  private key(): Uint8Array {
    const env = getEnv();
    return crypto.createHash('sha256').update(env.JWE_SECRET).digest();
  }

  async createEnvelope(
    jobId: string,
    secrets: Omit<SecretEnvelope, 'expiresAt'>,
    ttlMs = 300_000,
  ): Promise<{ jwe: string; referenceToken: string }> {
    const referenceToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    const envelope: SecretEnvelope = {
      ...secrets,
      expiresAt: expiresAt.toISOString(),
    };

    const payloadEncrypted = await new jose.CompactEncrypt(
      new TextEncoder().encode(JSON.stringify(envelope)),
    )
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(this.key());

    await getPool().query(
      `INSERT INTO secret_references (job_id, reference_token_hash, payload_encrypted, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [jobId, hashToken(referenceToken), payloadEncrypted, expiresAt.toISOString()],
    );

    // Dispatch JWE embeds callback credential + reference (worker unwraps via resolve-secret)
    const jwe = await new jose.CompactEncrypt(
      new TextEncoder().encode(
        JSON.stringify({ referenceToken, jobId, callbackToken: secrets.callbackToken }),
      ),
    )
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(this.key());

    return { jwe, referenceToken };
  }

  /**
   * Worker resolves dispatch JWE (single POST, no separate callback workflow input).
   * Verifies embedded callback token against job record; consumes secret reference once.
   */
  async resolveDispatchJwe(jwe: string): Promise<SecretEnvelope | null> {
    let referenceToken: string;
    let jobId: string;
    let callbackToken: string;
    try {
      const { plaintext } = await jose.compactDecrypt(jwe, this.key());
      const outer = JSON.parse(new TextDecoder().decode(plaintext)) as {
        referenceToken: string;
        jobId: string;
        callbackToken: string;
      };
      if (!outer.referenceToken || !outer.jobId || !outer.callbackToken) return null;
      referenceToken = outer.referenceToken;
      jobId = outer.jobId;
      callbackToken = outer.callbackToken;
    } catch {
      return null;
    }

    const tokenOk = await this.verifyCallbackToken(jobId, callbackToken);
    if (!tokenOk) return null;

    return this.resolveByReference(referenceToken, jobId);
  }

  /** Legacy path: callback bearer + reference jwe (job-scoped). */
  async resolve(jwe: string, jobId: string): Promise<SecretEnvelope | null> {
    let referenceToken: string;
    try {
      const { plaintext } = await jose.compactDecrypt(jwe, this.key());
      const outer = JSON.parse(new TextDecoder().decode(plaintext)) as {
        referenceToken: string;
        jobId: string;
      };
      if (outer.jobId !== jobId) return null;
      referenceToken = outer.referenceToken;
    } catch {
      return null;
    }
    return this.resolveByReference(referenceToken, jobId);
  }

  private async verifyCallbackToken(jobId: string, token: string): Promise<boolean> {
    const { rows } = await getPool().query(
      `SELECT callback_token_hash, callback_token_expires_at FROM jobs WHERE id = $1`,
      [jobId],
    );
    if (rows.length === 0) return false;
    const row = rows[0];
    if (!row.callback_token_hash || !row.callback_token_expires_at) return false;
    if (new Date(row.callback_token_expires_at) < new Date()) return false;
    return hashToken(token) === row.callback_token_hash;
  }

  private async resolveByReference(
    referenceToken: string,
    jobId: string,
  ): Promise<SecretEnvelope | null> {
    const hash = hashToken(referenceToken);
    const { rows } = await getPool().query(
      `SELECT id, payload_encrypted, consumed_at, expires_at, job_id
       FROM secret_references WHERE reference_token_hash = $1`,
      [hash],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.job_id !== jobId) return null;
    if (row.consumed_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    const upd = await getPool().query(
      `UPDATE secret_references SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [row.id],
    );
    if (upd.rowCount === 0) return null;

    try {
      const { plaintext } = await jose.compactDecrypt(row.payload_encrypted, this.key());
      return JSON.parse(new TextDecoder().decode(plaintext)) as SecretEnvelope;
    } catch {
      return null;
    }
  }
}

export const secretService = new SecretService();