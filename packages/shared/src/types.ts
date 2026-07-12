import type {
  CommitStrategy,
  JobStatus,
  LockHealth,
  Role,
  WorkerTier,
} from './job-status.js';
import type { AlertSeverity, ErrorCode } from './errors.js';

export interface Project {
  id: string;
  name: string;
  slug: string;
  godotVersion: string;
  projectRoot: string;
  highVolume: boolean;
  adminContacts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  status: JobStatus;
  tier: WorkerTier | null;
  commitStrategy: CommitStrategy;
  godotVersion: string;
  fencingToken: string | null;
  lockKey: string | null;
  githubRunId: number | null;
  callbackTokenHash: string | null;
  callbackTokenExpiresAt: string | null;
  attempt: number;
  maxAttempts: number;
  blockedByJobId: string | null;
  dependsOnJobId: string | null;
  estimatedWaitSeconds: number | null;
  s3StagingPrefix: string | null;
  s3ValidationReportKey: string | null;
  s3SnapshotKey: string | null;
  s3ArtifactsPrefix: string | null;
  metadata: Record<string, unknown>;
  lastHeartbeatAt: string | null;
  errorCode: ErrorCode | null;
  errorDetail: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobError {
  id: string;
  jobId: string;
  code: ErrorCode;
  class: string;
  severity: AlertSeverity;
  detail: string;
  artifactsS3Key: string | null;
  createdAt: string;
}

export interface LockFencingEntry {
  id: string;
  lockKey: string;
  owner: string;
  token: string;
  instanceId: string;
  reason:
    | 'ACQUIRED'
    | 'REENTRANT'
    | 'STALE_RECOVERED'
    | 'ADMIN_RECLAIM'
    | 'FAILOVER';
  acquiredAt: string;
  releasedAt: string | null;
  adminIdentity: string | null;
}

export interface ActiveLock {
  lockKey: string;
  ownerId: string;
  fencingToken: string;
  health: LockHealth;
  ttlSeconds: number;
  history: LockFencingEntry[];
}

export interface UidMapping {
  id: string;
  projectId: string;
  logicalAssetPath: string;
  uid: string;
  namespace: 'GEN-' | 'OVRD-' | 'TMP-' | 'USER-';
  reservedByJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Baseline {
  id: string;
  projectId: string;
  s3Key: string;
  checksum: string;
  createdAt: string;
}

export interface OverrideRecord {
  id: string;
  projectId: string;
  path: string;
  patch: Record<string, unknown>;
  introducesScript: boolean;
  createdBy: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorRole: Role | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ApiTokenMeta {
  id: string;
  jti: string;
  name: string;
  role: Role;
  userId: string;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ExtensionPolicy {
  id: string;
  extensionId: string;
  name: string;
  godotVersionRange: string;
  networkAllowed: boolean;
  approvedDomains: string[];
  maxCpu: number;
  maxMemoryMiB: number;
  maxDiskMiB: number;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionApprovalRequest {
  id: string;
  extensionId: string;
  requestedDomains: string[];
  reason: string;
  riskAssessment: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  reviewedBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ParityCheckResult {
  id: string;
  tierAChecksum: string;
  tierBChecksum: string;
  tierADurationMs: number;
  tierBDurationMs: number;
  passed: boolean;
  diffS3Key: string | null;
  createdAt: string;
}

export interface CreateJobRequest {
  projectId: string;
  commitStrategy?: CommitStrategy;
  godotVersion?: string;
  preferredTier?: WorkerTier;
  dependsOnJobId?: string;
  metadata?: Record<string, unknown>;
}

export interface JobStatusUpdate {
  status: JobStatus;
  metadata?: Record<string, unknown>;
  errorCode?: ErrorCode;
  errorDetail?: string;
  s3StagingPrefix?: string;
  s3ValidationReportKey?: string;
  s3SnapshotKey?: string;
  s3ArtifactsPrefix?: string;
  githubRunId?: number;
  fencingToken?: string;
}

export interface HeartbeatRequest {
  fencingToken?: string;
  metadata?: Record<string, unknown>;
}

export interface UidReservationRequest {
  logicalAssetPath: string;
  namespace?: 'GEN-' | 'OVRD-';
  jobId?: string;
}

export interface UidCommitRequest {
  reservationId: string;
  finalUid: string;
}

export interface LockReclaimRequest {
  lockKey: string;
  reason: string;
}

export interface MergeOverrideRequest {
  projectId: string;
  path: string;
  patch: Record<string, unknown>;
}

export interface ExecuteExtensionRequest {
  extensionId: string;
  projectId: string;
  inputs: Record<string, unknown>;
  network?: boolean;
}

export interface ResolveSecretRequest {
  jwe: string;
}

export interface WsJobEvent {
  type: 'job.updated' | 'job.error' | 'lock.updated' | 'parity.result' | 'alert';
  payload: unknown;
  at: string;
}

export interface DispatchInputs {
  jobId: string;
  projectId: string;
  godotVersion: string;
  commitStrategy: CommitStrategy;
  tier: WorkerTier;
  /** Dispatch JWE — embeds callback credential; never pass callbackToken as workflow input. */
  secretJwe: string;
}

export interface SecretPresignedUrls {
  stagingPut?: string;
  stagingGet?: string;
  stagingArchivePut?: string;
  validationPut?: string;
  snapshotPut?: string;
  snapshotGet?: string;
  diagnosticsPut?: string;
}

export interface SecretEnvelope {
  callbackToken?: string;
  fencingToken?: string;
  lockKey?: string;
  lockOwner?: string;
  targetProjectRoot?: string;
  targetHost?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3SessionToken?: string;
  sshPrivateKey?: string;
  sshKeyId?: string;
  /** L-05: orchestrator REIMPORT_TIMEOUT_MS → worker REIMPORT_TIMEOUT_SEC */
  reimportTimeoutSec?: number;
  /** L-05: orchestrator REIMPORT_MAX_RETRIES */
  reimportMaxRetries?: number;
  /** H-02: merge-apply outbox id (direct dispatch JWE) */
  outboxId?: string;
  /** H-02: relative .tscn path on target */
  relPath?: string;
  /** H-02: orchestrator base URL for complete callback */
  pgosBaseUrl?: string;
  /** H-02: presigned GET for patch.json (also may appear as workflow input) */
  patchGetUrl?: string;
  presignedUrls?: SecretPresignedUrls;
  expiresAt: string;
}
