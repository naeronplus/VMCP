import path from 'node:path';

/**
 * Filesystem traversal prevention (§9.4).
 * Resolves candidate against base and rejects escape attempts.
 */
export function assertWithinBase(baseDir: string, candidate: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, candidate);

  const baseWithSep = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;

  if (resolved !== resolvedBase && !resolved.startsWith(baseWithSep)) {
    throw new PathTraversalError(
      `Path escapes allowed base directory: ${candidate}`,
    );
  }
  return resolved;
}

export function isSafeLogicalAssetPath(logicalPath: string): boolean {
  if (!logicalPath || logicalPath.includes('\0')) return false;
  if (logicalPath.includes('..')) return false;
  if (path.isAbsolute(logicalPath)) return false;
  // Godot res:// style relative paths
  const normalized = logicalPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (normalized.includes('//')) return false;
  return /^[a-zA-Z0-9_./\-]+$/.test(normalized);
}

export function normalizeLogicalPath(logicalPath: string): string {
  return logicalPath.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export class PathTraversalError extends Error {
  readonly code = 'E014' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Commit-agent path rules (§4.2.1):
 * - source must be under /tmp/staging-
 * - target must be under allowed project root
 */
/**
 * S3 artifact keys must live under projects/{uuid}/jobs/{uuid}/...
 */
export function assertArtifactKey(key: string): string {
  if (!key || key.includes('\0')) {
    throw new PathTraversalError('Artifact key is required');
  }
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..') || normalized.includes('//')) {
    throw new PathTraversalError(`Invalid artifact key: ${key}`);
  }
  const uuid =
    /^projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\//i;
  if (!uuid.test(normalized)) {
    throw new PathTraversalError(
      `Artifact key must match projects/{projectId}/jobs/{jobId}/... : ${key}`,
    );
  }
  return normalized;
}

export function assertArtifactKeyForJob(
  key: string,
  projectId: string,
  jobId: string,
): string {
  const normalized = assertArtifactKey(key);
  const expectedPrefix = `projects/${projectId}/jobs/${jobId}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new PathTraversalError(
      `Artifact key must be under ${expectedPrefix}`,
    );
  }
  return normalized;
}

export function assertStagingSource(sourceTempDir: string): string {
  const resolved = path.resolve(sourceTempDir);
  const normalized = resolved.replace(/\\/g, '/');
  // Must contain a staging-* path segment (Linux /tmp/staging-* or Windows temp)
  const hasStagingSegment = /(?:^|\/)staging-[^/]+(?:\/|$)/.test(normalized);
  if (!hasStagingSegment) {
    throw new PathTraversalError(
      `Source must be under a staging-* directory: ${sourceTempDir}`,
    );
  }
  if (normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new PathTraversalError(`Path traversal rejected: ${sourceTempDir}`);
  }
  return resolved;
}
