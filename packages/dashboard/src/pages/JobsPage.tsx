import { useCallback, useEffect, useState } from 'react';
import { api, type JobRow, type ProjectRow } from '../api/client';
import { usePgosWebSocket } from '../hooks/usePgosWebSocket';

export function JobsPage({ role }: { role: string }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [j, p] = await Promise.all([
      api.jobs(projectId || undefined),
      api.projects(),
    ]);
    setJobs(j.jobs);
    setProjects(p.projects);
    if (!projectId && p.projects[0]) setProjectId(p.projects[0].id);
  }, [projectId]);

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  usePgosWebSocket({
    projectIds: projectId ? [projectId] : [],
    onEvent: (ev) => {
      if (ev.type === 'job.updated' && ev.payload && typeof ev.payload === 'object') {
        const updated = ev.payload as JobRow;
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...updated };
            return next;
          }
          if (!projectId || updated.projectId === projectId) {
            return [updated, ...prev];
          }
          return prev;
        });
      }
    },
  });

  return (
    <>
      <div className="header">
        <h1>Jobs</h1>
        <div className="row-actions">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="btn"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!projectId || (role !== 'operator' && role !== 'admin')}
            onClick={async () => {
              try {
                await api.createJob(projectId);
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Enqueue generation
          </button>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Tier</th>
              <th>Attempt</th>
              <th>Error</th>
              <th>Wait</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="mono">{j.id}</td>
                <td>
                  <span className="badge info">{j.status}</span>
                </td>
                <td>{j.tier ?? '—'}</td>
                <td>{j.attempt}</td>
                <td className="mono">
                  {j.errorCode ? (
                    <a href={`/api/v1/docs/errors/${j.errorCode}`} title={j.errorDetail ?? ''}>
                      {j.errorCode}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{j.estimatedWaitSeconds ?? 0}s</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.length === 0 && <div className="empty">No jobs</div>}
      </div>
    </>
  );
}