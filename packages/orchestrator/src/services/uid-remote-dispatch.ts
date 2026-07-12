/**
 * H-03: Auto-dispatch remote UID file reconcile when project_root is not local.
 */
import { s3Service } from './s3-service.js';
import { githubService } from './github-service.js';
import { audit } from './audit-service.js';
import { sendAlert } from './alert-service.js';

export const UID_RECONCILE_WORKFLOW = 'uid_reconcile.yml';

export type UidRemoteDispatchResult =
  | {
      mode: 'remote_dispatched';
      s3Key: string;
      workflowRunId?: number;
      mock?: boolean;
    }
  | {
      mode: 'remote_script';
      detail: string;
    };

export type UidRemoteDispatchDeps = {
  putObject: (key: string, body: string, contentType?: string) => Promise<void>;
  presignGet: (key: string, expiresIn?: number) => Promise<string>;
  dispatchWorkflowFile: (
    workflowId: string,
    inputs: Record<string, string>,
  ) => Promise<{ dispatched: boolean; mock?: boolean; mockRunId?: number }>;
  audit: typeof audit;
  sendAlert: typeof sendAlert;
};

export function createDefaultUidRemoteDispatchDeps(): UidRemoteDispatchDeps {
  return {
    putObject: (key, body, contentType) =>
      s3Service.putObject(key, body, contentType).then(() => undefined),
    presignGet: (key, expiresIn) => s3Service.presignGet(key, expiresIn),
    dispatchWorkflowFile: (id, inputs) =>
      githubService.dispatchWorkflowFile(id, inputs),
    audit,
    sendAlert,
  };
}

/**
 * Whether metadata indicates a remote host that can run uid-reconcile.
 */
export function canAutoDispatchUidReconcile(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const host = metadata.targetHost ?? metadata.target_host;
  const provision =
    metadata.targetProvisionUrl ??
    metadata.target_provision_url ??
    metadata.uidReconcileUrl ??
    metadata.uid_reconcile_url;
  // Prefer host + provision; allow host alone for Tier A self-hosted co-location
  return Boolean(host) || Boolean(provision);
}

/**
 * Upload replacements map to S3 and dispatch uid_reconcile.yml.
 */
export async function dispatchUidReconcile(opts: {
  projectId: string;
  projectRoot: string;
  replacements: Map<string, string> | Record<string, string>;
  metadata?: Record<string, unknown> | null;
  deps?: UidRemoteDispatchDeps;
}): Promise<UidRemoteDispatchResult> {
  const deps = opts.deps ?? createDefaultUidRemoteDispatchDeps();
  const meta = opts.metadata ?? {};

  if (!canAutoDispatchUidReconcile(meta)) {
    await deps.audit({
      action: 'uid.nightly_reconcile',
      resourceType: 'project',
      resourceId: opts.projectId,
      detail: {
        mode: 'remote_script',
        note: 'project_root not local; missing targetHost/targetProvisionUrl for auto-dispatch — run workers/scripts/uid-reconcile.sh on host',
        replacementCount:
          opts.replacements instanceof Map
            ? opts.replacements.size
            : Object.keys(opts.replacements).length,
      },
    });
    return {
      mode: 'remote_script',
      detail:
        'project_root not readable; set metadata.targetHost (+ targetProvisionUrl) for auto-dispatch',
    };
  }

  const mapObj: Record<string, string> =
    opts.replacements instanceof Map
      ? Object.fromEntries(opts.replacements.entries())
      : { ...opts.replacements };

  const stamp = Date.now();
  const s3Key = `projects/${opts.projectId}/uid-reconcile/${stamp}-replacements.json`;
  await deps.putObject(s3Key, JSON.stringify(mapObj), 'application/json');
  const replacementsGetUrl = await deps.presignGet(s3Key, 3600);

  try {
    const dispatched = await deps.dispatchWorkflowFile(UID_RECONCILE_WORKFLOW, {
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      replacementsS3Key: s3Key,
      replacementsGetUrl,
    });

    await deps.audit({
      action: 'uid.nightly_reconcile',
      resourceType: 'project',
      resourceId: opts.projectId,
      detail: {
        mode: 'remote_dispatched',
        workflow: UID_RECONCILE_WORKFLOW,
        s3Key,
        workflowRunId: dispatched.mockRunId ?? null,
        mock: dispatched.mock ?? false,
        replacementCount: Object.keys(mapObj).length,
      },
    });

    return {
      mode: 'remote_dispatched',
      s3Key,
      workflowRunId: dispatched.mockRunId,
      mock: dispatched.mock,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await deps.audit({
      action: 'uid.nightly_reconcile',
      resourceType: 'project',
      resourceId: opts.projectId,
      detail: {
        mode: 'remote_script',
        dispatchFailed: true,
        detail,
        s3Key,
      },
    });
    await deps.sendAlert({
      title: 'UID remote reconcile dispatch failed',
      severity: 'high',
      body: `project=${opts.projectId}: ${detail}`,
      code: 'E008',
      projectId: opts.projectId,
    });
    return {
      mode: 'remote_script',
      detail: `dispatch failed: ${detail}`,
    };
  }
}
