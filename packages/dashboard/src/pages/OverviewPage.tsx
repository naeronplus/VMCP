import { useCallback, useEffect, useState } from 'react';
import { api, type JobRow, type LockRow, type TierRow } from '../api/client';
import { usePgosWebSocket } from '../hooks/usePgosWebSocket';

export function OverviewPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    const [j, l, t] = await Promise.all([api.jobs(), api.locks(), api.tiers()]);
    setJobs(j.jobs);
    setLocks(l.locks);
    setTiers(t.tiers);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // L-09: WebSocket live updates on Overview (not Jobs-only)
  const projectIds = Array.from(new Set(jobs.map((j) => j.projectId).filter(Boolean)));
  usePgosWebSocket({
    projectIds,
    enabled: true,
    onEvent: (ev) => {
      setLive(true);
      if (ev.type === 'job.updated' && ev.payload && typeof ev.payload === 'object') {
        const updated = ev.payload as JobRow;
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...updated };
            return next;
          }
          return [updated, ...prev].slice(0, 50);
        });
      }
      if (ev.type === 'lock.updated' || ev.type === 'tier.updated') {
        void refresh();
      }
    },
  });

  const active = jobs.filter((j) =>
    ['QUEUED', 'DISPATCHING', 'STAGING', 'VALIDATING', 'COMMITTING', 'BLOCKED'].includes(
      j.status,
    ),
  ).length;
  const failed = jobs.filter((j) =>
    ['REIMPORT_FAILED', 'VALIDATION_FAILED', 'COMMIT_FAILED', 'DEAD_LETTER'].includes(
      j.status,
    ),
  ).length;

  return (
    <>
      <div className="header">
        <h1>Overview</h1>
        <span className="muted">
          Railway-first orchestrator · S3 artifacts · push dispatch
          {live ? ' · live' : ''}
        </span>
      </div>
      <div className="card-grid">
        <div className="card">
          <div className="label">Active jobs</div>
          <div className="value">{active}</div>
        </div>
        <div className="card">
          <div className="label">Failed / DLQ</div>
          <div className="value">{failed}</div>
        </div>
        <div className="card">
          <div className="label">Active locks</div>
          <div className="value">{locks.length}</div>
        </div>
        <div className="card">
          <div className="label">Tiers healthy</div>
          <div className="value">
            {tiers.filter((t) => t.enabled && !t.degraded).length}/{tiers.length || 2}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header">
          <strong>Recent jobs</strong>
        </div>
        {jobs.length === 0 ? (
          <div className="empty">No jobs yet. Create a project and enqueue generation.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Tier</th>
                <th>Godot</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 10).map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.id.slice(0, 8)}</td>
                  <td>
                    <span className={`badge ${statusClass(j.status)}`}>{j.status}</span>
                  </td>
                  <td>{j.tier ?? '—'}</td>
                  <td className="mono">{j.godotVersion}</td>
                  <td className="muted">{new Date(j.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function statusClass(s: string): string {
  if (s === 'COMPLETED') return 'ok';
  if (s.includes('FAIL') || s === 'DEAD_LETTER' || s === 'ROLLBACK') return 'danger';
  if (s === 'BLOCKED' || s === 'DISPATCH_TIMEOUT' || s === 'LOCK_STALE') return 'warn';
  return 'info';
}
