import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ProjectRow, type UidReservation } from '../api/client';
import { canCreateProject, canEnqueueJob } from '../lib/rbac';

export function ProjectsPage({ role }: { role: string }) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [projectRoot, setProjectRoot] = useState('/var/godot/projects/demo');
  const [godotVersion, setGodotVersion] = useState('4.3.1');
  const [highVolume, setHighVolume] = useState(false);
  const [uidProjectId, setUidProjectId] = useState('');
  const [logicalPath, setLogicalPath] = useState('res://assets/gen/item.tscn');
  const [lastReservation, setLastReservation] = useState<UidReservation | null>(null);
  const admin = canCreateProject(role);
  const canReserve = canEnqueueJob(role);

  const refresh = useCallback(async () => {
    const r = await api.projects();
    setProjects(r.projects);
  }, []);

  useEffect(() => {
    void refresh()
      .then((/* side-effect: set default uid project */) => undefined)
      .catch((e) => {
        setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
      });
  }, [refresh]);

  useEffect(() => {
    if (!uidProjectId && projects[0]) setUidProjectId(projects[0].id);
  }, [projects, uidProjectId]);

  return (
    <>
      <div className="header">
        <h1>Projects</h1>
        <span className="muted">
          {admin ? 'Admin can create projects' : 'Read-only list'}
          {canReserve ? ' · operator can reserve UIDs' : ''}
        </span>
      </div>
      {error && <div className="error-text">{error}</div>}

      {admin && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Create project</h2>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              className="btn"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="btn"
              placeholder="slug-kebab"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <input
              className="btn"
              placeholder="project root"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              style={{ minWidth: 220 }}
            />
            <input
              className="btn"
              placeholder="Godot version"
              value={godotVersion}
              onChange={(e) => setGodotVersion(e.target.value)}
            />
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={highVolume}
                onChange={(e) => setHighVolume(e.target.checked)}
              />
              High volume
            </label>
            <button
              className="btn primary"
              onClick={async () => {
                setError('');
                try {
                  await api.createProject({
                    name,
                    slug,
                    projectRoot,
                    godotVersion,
                    highVolume,
                  });
                  setName('');
                  setSlug('');
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
              Create
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Godot</th>
              <th>High volume</th>
              <th>Root</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{p.slug}</td>
                <td className="mono">{p.godot_version ?? p.godotVersion ?? '—'}</td>
                <td>{p.high_volume || p.highVolume ? 'yes' : 'no'}</td>
                <td className="mono muted">{p.project_root ?? p.projectRoot ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {projects.length === 0 && (
          <div className="empty">
            No projects yet
            {admin ? ' — create one above to unlock job enqueue' : ' — ask an admin to create one'}
          </div>
        )}
      </div>

      {canReserve && projects.length > 0 && (
        <div className="panel" style={{ marginTop: '1rem' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>UID reservation</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            POST /projects/:id/uid-reservations — concurrent-safe TMP- UID for a logical path
          </p>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <select
              className="btn"
              value={uidProjectId}
              onChange={(e) => setUidProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className="btn"
              style={{ minWidth: 280 }}
              value={logicalPath}
              onChange={(e) => setLogicalPath(e.target.value)}
              placeholder="res://path/to/asset.tscn"
            />
            <button
              type="button"
              className="btn primary"
              onClick={async () => {
                setError('');
                try {
                  const r = await api.uidReserve(uidProjectId, {
                    logicalAssetPath: logicalPath,
                    namespace: 'GEN-',
                  });
                  setLastReservation(r.reservation);
                } catch (e) {
                  setError(
                    e instanceof ApiError
                      ? `${e.code ?? e.status}: ${e.message}`
                      : String(e),
                  );
                }
              }}
            >
              Reserve UID
            </button>
          </div>
          {lastReservation && (
            <div className="muted mono" style={{ marginTop: 12 }}>
              reserved id={lastReservation.id.slice(0, 8)} uid={lastReservation.uid} path=
              {lastReservation.logicalAssetPath}
            </div>
          )}
        </div>
      )}
    </>
  );
}
