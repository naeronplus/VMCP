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

export const api = {
  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string; role: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () =>
    request<{ user: { id: string; email: string; role: string } | null }>('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  jobs: (projectId?: string) =>
    request<{ jobs: JobRow[] }>(
      `/jobs${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  createJob: (input: CreateJobInput | string) => {
    const body =
      typeof input === 'string' ? { projectId: input } : input;
    return request<{ job: JobRow }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  projects: () => request<{ projects: ProjectRow[] }>('/projects'),
  createProject: (input: CreateProjectInput) =>
    request<{ project: ProjectRow }>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  locks: () => request<{ locks: LockRow[] }>('/locks'),
  reclaimLock: (lockKey: string, reason: string) =>
    request('/locks/reclaim', {
      method: 'POST',
      body: JSON.stringify({ lockKey, reason }),
    }),
  deadLetter: () => request<{ items: DeadLetterRow[] }>('/dead-letter'),
  retryDeadLetter: (jobId: string) =>
    request(`/dead-letter/${jobId}/retry`, { method: 'POST' }),
  tiers: () => request<{ tiers: TierRow[] }>('/tiers'),
  parity: () => request<{ checks: ParityRow[] }>('/parity'),
  approvals: () =>
    request<{ approvals: ApprovalRow[] }>('/extension-approvals?status=pending'),
  reviewApproval: (id: string, status: 'approved' | 'rejected') =>
    request(`/extension-approvals/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  errorCatalog: () =>
    request<{ catalog: Record<string, ErrorDef> }>('/errors/catalog'),
  searchErrors: (q: string) =>
    request<{ errors: JobErrorRow[] }>(
      `/jobs/errors/search?q=${encodeURIComponent(q)}`,
    ),
};

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
}

export interface LockRow {
  lockKey: string;
  ownerId: string;
  fencingToken: string;
  health: string;
  ttlSeconds: number;
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
}

export interface ParityRow {
  id: string;
  passed: boolean;
  tier_a_checksum: string;
  tier_b_checksum: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  extension_id: string;
  requested_domains: string[];
  reason: string;
  risk_assessment: string;
  status: string;
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
