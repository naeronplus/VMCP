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
 *
 * Two shapes (same crypto — dir + A256GCM):
 * 1. Job-linked: outer { referenceToken, jobId, callbackToken } + secret_references row
 * 2. Direct (H-02 merge-outbox): outer { kind:'direct', purpose, envelope } — no job FK
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
   * H-02 / maintenance workflows: self-contained dispatch JWE (no jobs row).
   * Same jose dir+A256GCM as createEnvelope. Never put raw SSH in workflow inputs —
   * seal material here and pass only `secretJwe` to workflow_dispatch.
   */
  async createDirectDispatchJwe(
    secrets: Omit<SecretEnvelope, 'expiresAt'>,
    opts?: { purpose?: string; ttlMs?: number },
  ): Promise<{ jwe: string; envelope: SecretEnvelope }> {
    const ttlMs = opts?.ttlMs ?? 3_600_000; // 1h — match patch presign
    const purpose = opts?.purpose ?? 'merge-apply';
    const expiresAt = new Date(Date.now() + ttlMs);
    const envelope: SecretEnvelope = {
      ...secrets,
      expiresAt: expiresAt.toISOString(),
    };
    const jwe = await new jose.CompactEncrypt(
      new TextEncoder().encode(
        JSON.stringify({
          kind: 'direct',
          purpose,
          callbackToken: secrets.callbackToken ?? '',
          envelope,
        }),
      ),
    )
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(this.key());
    return { jwe, envelope };
  }

  /**
   * Worker resolves dispatch JWE (single POST, no separate callback workflow input).
   * Supports job-linked references and direct (merge-outbox) envelopes.
   */
  async resolveDispatchJwe(jwe: string): Promise<SecretEnvelope | null> {
    try {
      const { plaintext } = await jose.compactDecrypt(jwe, this.key());
      const outer = JSON.parse(new TextDecoder().decode(plaintext)) as {
        kind?: string;
        purpose?: string;
        referenceToken?: string;
        jobId?: string;
        callbackToken?: string;
        envelope?: SecretEnvelope;
      };

      // H-02 direct envelope (merge-apply, etc.)
      if (outer.kind === 'direct' && outer.envelope) {
        const exp = outer.envelope.expiresAt;
        if (!exp || new Date(exp) < new Date()) return null;
        return outer.envelope;
      }

      if (!outer.referenceToken || !outer.jobId || !outer.callbackToken) return null;

      const tokenOk = await this.verifyCallbackToken(outer.jobId, outer.callbackToken);
      if (!tokenOk) return null;

      return this.resolveByReference(outer.referenceToken, outer.jobId);
    } catch {
      return null;
    }
  }

  // L-06: legacy resolve(jwe, jobId) removed — zero callers; use resolveDispatchJwe only.

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