/** Dashboard nav/route RBAC aligned with orchestrator API policy (H-07). */

export type DashboardRole = 'viewer' | 'operator' | 'admin' | 'callback' | string;

export type DashboardRoute =
  | '/'
  | '/jobs'
  | '/projects'
  | '/locks'
  | '/dead-letter'
  | '/tiers'
  | '/extensions'
  | '/errors'
  | '/docs';

const ROUTE_MIN_ROLE: Record<DashboardRoute, DashboardRole | null> = {
  '/': 'viewer',
  '/jobs': 'viewer',
  '/projects': 'viewer',
  '/locks': 'viewer',
  '/dead-letter': 'operator',
  '/tiers': 'viewer',
  '/extensions': 'admin',
  '/errors': 'viewer',
  '/docs': 'viewer',
};

const RANK: Record<string, number> = {
  callback: 0,
  viewer: 1,
  operator: 2,
  admin: 3,
};

export function roleRank(role: string): number {
  return RANK[role] ?? 0;
}

export function canAccess(role: string, route: DashboardRoute): boolean {
  const min = ROUTE_MIN_ROLE[route];
  if (!min) return true;
  return roleRank(role) >= roleRank(min);
}

export function canCreateProject(role: string): boolean {
  return role === 'admin';
}

export function canEnqueueJob(role: string): boolean {
  return role === 'operator' || role === 'admin';
}

export function canReclaimLock(role: string): boolean {
  return role === 'operator' || role === 'admin';
}
