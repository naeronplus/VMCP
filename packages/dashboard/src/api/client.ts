const API = '/api/v1';

async function request<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string; role: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ user: { id: string; email: string; role: string } | null }>('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  jobs: (projectId?: string) =>
    request<{ jobs: JobRow[] }>(
      `/jobs${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  createJob: (projectId: string) =>
    request<{ job: JobRow }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }),
  projects: () => request<{ projects: ProjectRow[] }>('/projects'),
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
  errorCatalog: () => request<{ catalog: Record<string, ErrorDef> }>('/errors/catalog'),
  searchErrors: (q: string) =>
    request<{ errors: JobErrorRow[] }>(`/jobs/errors/search?q=${encodeURIComponent(q)}`),
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
  godot_version: string;
  high_volume: boolean;
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
