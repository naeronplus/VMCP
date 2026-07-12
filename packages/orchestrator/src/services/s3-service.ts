import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../config/env.js';

/**
 * All worker-touched artifacts go through S3 only (§2.1).
 * Railway volume is never used for staging/snapshots/artifacts.
 */
export class S3Service {
  private client: S3Client | null = null;
  private memoryStore = new Map<string, Buffer>();

  private getClient(): S3Client | null {
    const env = getEnv();
    if (!env.S3_ACCESS_KEY_ID) {
      if (env.NODE_ENV === 'production') {
        throw new Error('S3_ACCESS_KEY_ID is required in production');
      }
      return null; // in-memory fallback for local/dev without MinIO
    }
    if (!this.client) {
      this.client = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT || undefined,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
        },
      });
    }
    return this.client;
  }

  async putObject(
    key: string,
    body: Buffer | string,
    contentType = 'application/octet-stream',
  ): Promise<{ key: string; bucket: string }> {
    const env = getEnv();
    const client = this.getClient();
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    if (!client) {
      this.memoryStore.set(key, buf);
      return { key, bucket: env.S3_BUCKET };
    }
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: buf,
        ContentType: contentType,
      }),
    );
    return { key, bucket: env.S3_BUCKET };
  }

  async getObject(key: string): Promise<Buffer | null> {
    const env = getEnv();
    const client = this.getClient();
    if (!client) {
      return this.memoryStore.get(key) ?? null;
    }
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    const env = getEnv();
    const client = this.getClient();
    if (!client) return this.memoryStore.has(key);
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async presignGet(key: string, expiresIn = 3600): Promise<string> {
    const env = getEnv();
    const client = this.getClient();
    if (!client) {
      return `${env.PUBLIC_BASE_URL}/api/v1/artifacts/local/${encodeURIComponent(key)}`;
    }
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      { expiresIn },
    );
  }

  async presignPut(key: string, expiresIn = 3600): Promise<string> {
    const env = getEnv();
    const client = this.getClient();
    if (!client) {
      return `${env.PUBLIC_BASE_URL}/api/v1/artifacts/local-upload/${encodeURIComponent(key)}`;
    }
    return getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      { expiresIn },
    );
  }

  jobPrefix(projectId: string, jobId: string): string {
    return `projects/${projectId}/jobs/${jobId}`;
  }

  stagingKey(projectId: string, jobId: string, file = 'staging.tar.gz'): string {
    return `${this.jobPrefix(projectId, jobId)}/staging/${file}`;
  }

  snapshotKey(projectId: string, jobId: string): string {
    return `${this.jobPrefix(projectId, jobId)}/snapshots/pre-commit.tar.gz`;
  }

  validationReportKey(projectId: string, jobId: string): string {
    return `${this.jobPrefix(projectId, jobId)}/validation/report.json`;
  }

  diagnosticsKey(projectId: string, jobId: string, name: string): string {
    return `${this.jobPrefix(projectId, jobId)}/diagnostics/${name}`;
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const env = getEnv();
    const client = this.getClient();
    if (!client) {
      return [...this.memoryStore.keys()].filter((k) => k.startsWith(prefix));
    }
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix }),
    );
    return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
  }
}

export const s3Service = new S3Service();
