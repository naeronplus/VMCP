/**
 * Dashboard API client — typed wrappers for `/api/v1/*` (plan §7.8 / report §11.2).
 * Keep in sync with orchestrator routes under packages/orchestrator/src/routes/.
 */
const API = '/api/v1';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    ...opts,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const code = body?.error?.code;
    const message =
      body?.error?.message ??
      (code ? `${code}: HTTP ${res.status}` : `HTTP ${res.status}`);
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Request / input types ─────────────────────────────────────────────

export interface CreateJobInput {
  projectId: string;
  godotVersion?: string;
  preferredTier?: 'A' | 'B';
  commitStrategy?: 'same-machine' | 'cross-machine';
  dependsOnJobId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  godotVersion?: string;
  projectRoot: string;
  highVolume?: boolean;
  adminContacts?: string[];
}

export interface UidReserveInput {
  logicalAssetPath: string;
  namespace?: 'GEN-' | 'OVRD-';
  jobId?: string;
}

export interface UidCommitInput {
  reservationId: string;
  finalUid: string;
  namespace?: 'GEN-' | 'OVRD-' | 'USER-';
}

export interface ListAuditLogsQuery {
  limit?: number;
  resourceType?: string;
  resourceId?: string;
}

// ── Response row types ────────────────────────────────────────────────

export interface JobRow {
  id: string;
  projectId: string;
  status: string;
  tier: string | null;
  godotVersion: string;
  attempt: number;
  errorCode: string | null;
  errorDetail: string | null;
  estimatedWaitSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  commitStrategy?: string;
  dependsOnJobId?: string | null;
  metadata?: Record<string, unknown>;
  lockKey?: string | null;
  fencingToken?: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  godot_version?: string;
  godotVersion?: string;
  high_volume?: boolean;
  highVolume?: boolean;
  project_root?: string;
  projectRoot?: string;
  admin_contacts?: string[];
  created_at?: string;
}

export interface LockRow {
  lockKey: string;
  ownerId: string;
  fencingToken: string;
  health: string;
  ttlSeconds: number;
  history?: LockHistoryEntry[];
}

export interface LockHistoryEntry {
  id: string;
  lockKey: string;
  owner: string;
  token: string;
  instanceId: string | null;
  reason: string;
  acquiredAt: string;
  releasedAt: string | null;
  adminIdentity: string | null;
}

export interface DeadLetterRow {
  job_id: string;
  reason: string;
  attempts: number;
  created_at: string;
  project_id: string;
}

export interface TierRow {
  tier: string;
  enabled: boolean;
  degraded: boolean;
  avg_cold_start_ms: number | null;
  tier_b_runner_online?: boolean | null;
  godot_cache_warm?: boolean | null;
  probe_source?: string | null;
  probe_detail?: string | null;
  last_probe_at?: string | null;
}

export interface ParityRow {
  id: string;
  passed: boolean;
  tier_a_checksum: string;
  tier_b_checksum: string;
  created_at: string;
  skipped?: boolean;
  reason?: string | null;
}

export interface ApprovalRow {
  id: string;
  extension_id: string;
  requested_domains: string[];
  reason: string;
  risk_assessment: string;
  status: string;
}

export interface ExtensionPolicyRow {
  id?: string;
  extension_id: string;
  name: string;
  godot_version_range?: string | null;
  network_allowed?: boolean;
  approved_domains?: string[];
  max_cpu?: number | null;
  max_memory_mib?: number | null;
  max_disk_mib?: number | null;
  timeout_seconds?: number | null;
}

export interface UidReservation {
  id: string;
  uid: string;
  logicalAssetPath: string;
}

export interface UidMappingRow {
  id: string;
  project_id: string;
  logical_asset_path: string;
  uid: string;
  namespace: string;
  reserved_by_job_id?: string | null;
  updated_at?: string;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface ErrorDef {
  code: string;
  class: string;
  severity: string;
  operatorAction: string;
  docsPath: string;
}

export interface JobErrorRow {
  id: string;
  job_id: string;
  code: string;
  class: string;
  detail: string;
  created_at: string;
}

// ── Client ────────────────────────────────────────────────────────────

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string; role: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () =>
    request<{ user: { id: string; email: string; role: string } | null }>('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),

  // Jobs
  jobs: (projectId?: string) =>
    request<{ jobs: JobRow[] }>(
      `/jobs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  /** §7.8 — GET /jobs/:id */
  getJob: (jobId: string) =>
    request<{ job: JobRow }>(`/jobs/${encodeURIComponent(jobId)}`),
  createJob: (input: CreateJobInput | string) => {
    const body = typeof input === 'string' ? { projectId: input } : input;
    return request<{ job: JobRow }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  searchErrors: (q: string) =>
    request<{ errors: JobErrorRow[] }>(
      `/jobs/errors/search?q=${encodeURIComponent(q)}`,
    ),
  deadLetter: () => request<{ items: DeadLetterRow[] }>('/dead-letter'),
  retryDeadLetter: (jobId: string) =>
    request(`/dead-letter/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),

  // Projects
  projects: () => request<{ projects: ProjectRow[] }>('/projects'),
  /** §7.8 — POST /projects */
  createProject: (input: CreateProjectInput) =>
    request<{ project: ProjectRow }>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getProject: (projectId: string) =>
    request<{ project: ProjectRow }>(`/projects/${encodeURIComponent(projectId)}`),
  /** §7.8 — POST /projects/:id/uid-reservations */
  uidReserve: (projectId: string, input: UidReserveInput) =>
    request<{ reservation: UidReservation }>(
      `/projects/${encodeURIComponent(projectId)}/uid-reservations`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  uidCommit: (projectId: string, input: UidCommitInput) =>
    request<{ ok: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/uid-reservations/commit`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  listProjectUids: (projectId: string) =>
    request<{ mappings: UidMappingRow[] }>(
      `/projects/${encodeURIComponent(projectId)}/uids`,
    ),
  reconcileProjectUids: (projectId: string) =>
    request<{ result: unknown }>(
      `/projects/${encodeURIComponent(projectId)}/uids/reconcile`,
      { method: 'POST' },
    ),

  // Locks
  locks: () => request<{ locks: LockRow[] }>('/locks'),
  /** §7.8 — GET /locks/:key/history */
  lockHistory: (lockKey: string) =>
    request<{ history: LockHistoryEntry[] }>(
      `/locks/${encodeURIComponent(lockKey)}/history`,
    ),
  reclaimLock: (lockKey: string, reason: string) =>
    request<{ ok: boolean; newFencingToken: string; message: string }>('/locks/reclaim', {
      method: 'POST',
      body: JSON.stringify({ lockKey, reason }),
    }),

  // Tiers / parity
  tiers: () => request<{ tiers: TierRow[] }>('/tiers'),
  /** §7.8 — POST /tiers/:id/enable */
  enableTier: (tier: 'A' | 'B', enabled: boolean) =>
    request<{ ok: boolean }>(`/tiers/${encodeURIComponent(tier)}/enable`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  parity: () => request<{ checks: ParityRow[] }>('/parity'),

  // Admin
  /**
   * §7.8 — GET /audit-logs
   * Plan names this `/admin/audit-logs`; orchestrator mounts admin routes at `/api/v1`
   * so the client path is `/audit-logs` (admin role required server-side).
   */
  auditLogs: (query: ListAuditLogsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.limit != null) params.set('limit', String(query.limit));
    if (query.resourceType) params.set('resourceType', query.resourceType);
    if (query.resourceId) params.set('resourceId', query.resourceId);
    const qs = params.toString();
    return request<{ logs: AuditLogRow[] }>(`/audit-logs${qs ? `?${qs}` : ''}`);
  },
  errorCatalog: () =>
    request<{ catalog: Record<string, ErrorDef> }>('/errors/catalog'),

  // Extensions
  /** §7.8 — GET /extensions */
  listExtensions: () =>
    request<{ policies: ExtensionPolicyRow[] }>('/extensions'),
  approvals: (status = 'pending') =>
    request<{ approvals: ApprovalRow[] }>(
      `/extension-approvals?status=${encodeURIComponent(status)}`,
    ),
  reviewApproval: (id: string, status: 'approved' | 'rejected') =>
    request(`/extension-approvals/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  executeExtension: (input: {
    extensionId: string;
    projectId: string;
    inputs?: Record<string, unknown>;
    network?: boolean;
  }) =>
    request<{ result: unknown }>('/execute-extension', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

/** §7.8 plan method names — used by completeness tests. */
export const API_CLIENT_PLAN_METHODS = [
  'createProject',
  'getJob',
  'enableTier',
  'lockHistory',
  'auditLogs',
  'listExtensions',
  'uidReserve',
] as const;

export type ApiClientPlanMethod = (typeof API_CLIENT_PLAN_METHODS)[number];
