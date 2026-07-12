import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type JobRow, type ProjectRow } from '../api/client';
import { canEnqueueJob } from '../lib/rbac';
import { usePgosWebSocket } from '../hooks/usePgosWebSocket';

export function JobsPage({ role }: { role: string }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [godotVersion, setGodotVersion] = useState('');
  const [preferredTier, setPreferredTier] = useState<'' | 'A' | 'B'>('');
  const [commitStrategy, setCommitStrategy] = useState<
    'same-machine' | 'cross-machine'
  >('same-machine');
  const [dependsOnJobId, setDependsOnJobId] = useState('');
  const [selectedJob, setSelectedJob] = useState<JobRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const canEnqueue = canEnqueueJob(role);

  async function openJob(id: string) {
    setDetailLoading(true);
    setError('');
    try {
      const r = await api.getJob(id);
      setSelectedJob(r.job);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    } finally {
      setDetailLoading(false);
    }
  }

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
    void refresh().catch((e) => {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    });
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
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Hide advanced' : 'Advanced'}
          </button>
          <button
            className="btn primary"
            disabled={!projectId || !canEnqueue}
            title={
              !projectId
                ? 'Create a project first'
                : !canEnqueue
                  ? 'Requires operator or admin'
                  : undefined
            }
            onClick={async () => {
              setError('');
              try {
                await api.createJob({
                  projectId,
                  ...(godotVersion ? { godotVersion } : {}),
                  ...(preferredTier ? { preferredTier } : {}),
                  commitStrategy,
                  ...(dependsOnJobId ? { dependsOnJobId } : {}),
                });
                await refresh();
              } catch (e) {
                setError(
                  e instanceof ApiError
                    ? `${e.code ?? e.status}: ${e.message}`
                    : String(e),
                );
              }
            }}
          >
            Enqueue generation
          </button>
        </div>
      </div>
      {projects.length === 0 && (
        <div className="panel muted" style={{ marginBottom: '1rem' }}>
          No projects in the database. An admin must create one on the{' '}
          <a href="/projects">Projects</a> page before jobs can be enqueued.
        </div>
      )}
      {showAdvanced && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              className="btn"
              placeholder="Godot version (optional)"
              value={godotVersion}
              onChange={(e) => setGodotVersion(e.target.value)}
            />
            <select
              className="btn"
              value={preferredTier}
              onChange={(e) =>
                setPreferredTier(e.target.value as '' | 'A' | 'B')
              }
            >
              <option value="">Any tier</option>
              <option value="A">Tier A</option>
              <option value="B">Tier B</option>
            </select>
            <select
              className="btn"
              value={commitStrategy}
              onChange={(e) =>
                setCommitStrategy(
                  e.target.value as 'same-machine' | 'cross-machine',
                )
              }
            >
              <option value="same-machine">same-machine</option>
              <option value="cross-machine">cross-machine</option>
            </select>
            <input
              className="btn"
              placeholder="dependsOnJobId (uuid)"
              value={dependsOnJobId}
              onChange={(e) => setDependsOnJobId(e.target.value)}
              style={{ minWidth: 280 }}
            />
          </div>
        </div>
      )}
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
              <tr
                key={j.id}
                style={{ cursor: 'pointer' }}
                title="Load full job via GET /jobs/:id"
                onClick={() => void openJob(j.id)}
              >
                <td className="mono">{j.id}</td>
                <td>
                  <span className="badge info">{j.status}</span>
                </td>
                <td>{j.tier ?? '—'}</td>
                <td>{j.attempt}</td>
                <td className="mono">
                  {j.errorCode ? (
                    <a
                      href={`/api/v1/docs/errors/${j.errorCode}`}
                      title={j.errorDetail ?? ''}
                      onClick={(e) => e.stopPropagation()}
                    >
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

      {(selectedJob || detailLoading) && (
        <div className="panel" style={{ marginTop: '1rem' }}>
          <div className="panel-header">
            <strong>Job detail {detailLoading ? '(loading…)' : ''}</strong>
            <button type="button" className="btn" onClick={() => setSelectedJob(null)}>
              Close
            </button>
          </div>
          {selectedJob && (
            <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {JSON.stringify(selectedJob, null, 2)}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
