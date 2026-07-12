/**
 * Full job lifecycle states from the blueprint (§2.3, §4.1, §7.2).
 */
export const JOB_STATUSES = [
  'QUEUED',
  'DISPATCHING',
  'DISPATCH_TIMEOUT',
  'DISPATCH_FAILED',
  'BLOCKED',
  'STAGING',
  'VALIDATING',
  'VALIDATION_REPORT',
  'VALIDATION_FAILED',
  'REIMPORT_FAILED',
  'COMMITTING',
  'COMMIT_FAILED',
  'POST_COMMIT_VERIFY',
  'ROLLBACK',
  'COMPLETED',
  'LOCK_STALE',
  'DEP_FAILED',
  'PAUSED_EDITOR_LOCK',
  'CANCELLED',
  'DEAD_LETTER',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that hold the project generation lock. */
export const ACTIVE_GENERATION_STATUSES: readonly JobStatus[] = [
  'QUEUED',
  'DISPATCHING',
  'STAGING',
  'VALIDATING',
  'VALIDATION_REPORT',
  'COMMITTING',
  'POST_COMMIT_VERIFY',
] as const;

/**
 * Retriable failure statuses (§8.2).
 * These must NOT release the project lock or promote blocked jobs until
 * retries are exhausted (otherwise concurrent generation races occur).
 */
export const RETRIABLE_FAILURE_STATUSES: readonly JobStatus[] = [
  'REIMPORT_FAILED',
  'VALIDATION_FAILED',
  'COMMIT_FAILED',
  'DISPATCH_TIMEOUT',
  'DISPATCH_FAILED',
] as const;

/**
 * Final terminal statuses — job will not be auto-retried.
 * Retriable failures become final only after max attempts → DEAD_LETTER.
 */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'COMPLETED',
  'ROLLBACK',
  'DEP_FAILED',
  'CANCELLED',
  'DEAD_LETTER',
] as const;

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isRetriableFailure(status: JobStatus): boolean {
  return (RETRIABLE_FAILURE_STATUSES as readonly string[]).includes(status);
}

export function isActiveGeneration(status: JobStatus): boolean {
  return (ACTIVE_GENERATION_STATUSES as readonly string[]).includes(status);
}

/**
 * Allowed job status transitions (§2.3 FSM).
 * Terminal statuses accept no outbound transitions.
 */
export const JOB_STATUS_TRANSITIONS: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  QUEUED: ['DISPATCHING', 'DISPATCH_FAILED', 'BLOCKED', 'CANCELLED', 'LOCK_STALE'],
  DISPATCHING: [
    'STAGING',
    'DISPATCH_TIMEOUT',
    'DISPATCH_FAILED',
    'BLOCKED',
    'CANCELLED',
    'LOCK_STALE',
  ],
  DISPATCH_TIMEOUT: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'LOCK_STALE', 'DISPATCH_FAILED'],
  DISPATCH_FAILED: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'LOCK_STALE'],
  BLOCKED: ['QUEUED', 'CANCELLED'],
  STAGING: [
    'VALIDATING',
    'REIMPORT_FAILED',
    'PAUSED_EDITOR_LOCK',
    'LOCK_STALE',
    'CANCELLED',
  ],
  VALIDATING: [
    'VALIDATION_REPORT',
    'VALIDATION_FAILED',
    'REIMPORT_FAILED',
    'LOCK_STALE',
    'CANCELLED',
  ],
  VALIDATION_REPORT: ['COMMITTING', 'VALIDATION_FAILED', 'CANCELLED'],
  REIMPORT_FAILED: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'LOCK_STALE'],
  VALIDATION_FAILED: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'LOCK_STALE'],
  COMMITTING: [
    'POST_COMMIT_VERIFY',
    'COMMIT_FAILED',
    'PAUSED_EDITOR_LOCK',
    'LOCK_STALE',
    'CANCELLED',
  ],
  COMMIT_FAILED: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'LOCK_STALE'],
  POST_COMMIT_VERIFY: [
    'COMPLETED',
    'ROLLBACK',
    'REIMPORT_FAILED',
    'LOCK_STALE',
    'CANCELLED',
  ],
  ROLLBACK: [],
  COMPLETED: [],
  LOCK_STALE: ['QUEUED', 'DEAD_LETTER', 'CANCELLED', 'DISPATCH_FAILED'],
  DEP_FAILED: [],
  PAUSED_EDITOR_LOCK: ['STAGING', 'CANCELLED', 'LOCK_STALE'],
  CANCELLED: [],
  DEAD_LETTER: [],
};

export function canTransitionJobStatus(
  from: JobStatus,
  to: JobStatus,
): boolean {
  if (from === to) return true;
  const allowed = JOB_STATUS_TRANSITIONS[from] ?? [];
  return (allowed as readonly string[]).includes(to);
}

export type WorkerTier = 'A' | 'B';

export type CommitStrategy = 'same-machine' | 'cross-machine';

export type LockHealth = 'healthy' | 'stale' | 'reclaimed' | 'unknown';

/** Worker callback tokens use `callback` — scoped to a single job only. */
export type Role = 'callback' | 'viewer' | 'operator' | 'admin';

export const ROLE_RANK: Record<Role, number> = {
  callback: 0,
  viewer: 1,
  operator: 2,
  admin: 3,
};

export function hasMinRole(userRole: Role, required: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

/** Exact role match — used for callback-only endpoints (not minimum rank). */
export function hasExactRole(userRole: Role, required: Role): boolean {
  return userRole === required;
}
