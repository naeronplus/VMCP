import type { JobStatus } from '@vibrato/shared';
import { isActiveGeneration, isRetriableFailure, isTerminal } from '@vibrato/shared';

/**
 * Pure helpers for dependsOnJobId + concurrency blocking (H-01).
 */

export type DependencyGate =
  | { action: 'allow' }
  | { action: 'block_dependency'; reason: string }
  | { action: 'dep_failed'; reason: string };

/** Decide gate for a dependency job at create/dispatch time. */
export function evaluateDependencyGate(
  dep:
    | { id: string; projectId: string; status: JobStatus }
    | null
    | undefined,
  expectedProjectId: string,
): DependencyGate {
  if (!dep) {
    return { action: 'dep_failed', reason: 'Dependency job not found' };
  }
  if (dep.projectId !== expectedProjectId) {
    return {
      action: 'dep_failed',
      reason: `Dependency job ${dep.id} belongs to another project`,
    };
  }
  if (dep.status === 'COMPLETED') {
    return { action: 'allow' };
  }
  if (isTerminal(dep.status)) {
    return {
      action: 'dep_failed',
      reason: `Dependency job ${dep.id} ended with ${dep.status}`,
    };
  }
  return {
    action: 'block_dependency',
    reason: `Waiting on dependency job ${dep.id} (${dep.status})`,
  };
}

/**
 * Whether a BLOCKED job may be promoted after `finishedJobId` reaches `finishedStatus`.
 */
export function canPromoteBlockedJob(opts: {
  dependsOnJobId: string | null;
  blockedByJobId: string | null;
  finishedJobId: string;
  finishedStatus: JobStatus;
  dependencyStatus: JobStatus | null;
  /** Another job still holding the project generation slot (excluding the finished job). */
  concurrentActiveHeld: boolean;
  /** Status of the job referenced by blockedByJobId, if any. */
  blockedByStatus: JobStatus | null;
}): { promote: boolean; depFailed?: boolean; reason?: string } {
  if (opts.dependsOnJobId) {
    if (opts.dependencyStatus == null) {
      return { promote: false, depFailed: true, reason: 'Dependency missing' };
    }
    if (isTerminal(opts.dependencyStatus) && opts.dependencyStatus !== 'COMPLETED') {
      return {
        promote: false,
        depFailed: true,
        reason: `Dependency ended with ${opts.dependencyStatus}`,
      };
    }
    if (opts.dependencyStatus !== 'COMPLETED') {
      return { promote: false, reason: 'Dependency not completed' };
    }
  }

  if (opts.blockedByJobId && opts.blockedByJobId !== opts.finishedJobId) {
    const bs = opts.blockedByStatus;
    if (bs && (isActiveGeneration(bs) || isRetriableFailure(bs))) {
      return { promote: false, reason: 'Still blocked by another active job' };
    }
  }

  if (opts.concurrentActiveHeld) {
    return { promote: false, reason: 'Project concurrency slot held' };
  }

  return { promote: true };
}

/** Statuses that serialize project generation (matches job-service create). */
export const PROJECT_SLOT_ACTIVE_STATUSES: readonly JobStatus[] = [
  'QUEUED',
  'DISPATCHING',
  'STAGING',
  'VALIDATING',
  'VALIDATION_REPORT',
  'COMMITTING',
  'POST_COMMIT_VERIFY',
  'REIMPORT_FAILED',
  'VALIDATION_FAILED',
  'COMMIT_FAILED',
  'DISPATCH_TIMEOUT',
  'DISPATCH_FAILED',
] as const;
