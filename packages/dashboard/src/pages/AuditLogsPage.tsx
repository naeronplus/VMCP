import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AuditLogRow } from '../api/client';

/** Admin audit trail — uses api.auditLogs (GET /audit-logs). */
export function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState('');
  const [resourceType, setResourceType] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await api.auditLogs({
        limit: 100,
        ...(resourceType ? { resourceType } : {}),
      });
      setLogs(r.logs);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    }
  }, [resourceType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="header">
        <h1>Audit logs</h1>
        <span className="muted">Admin-only · GET /api/v1/audit-logs</span>
      </div>
      {error && (
        <div className="badge danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div className="row-actions" style={{ marginBottom: 12 }}>
        <input
          className="btn"
          placeholder="Filter resourceType (optional)"
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
        />
        <button type="button" className="btn primary" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Actor</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="muted">
                  {l.created_at ? new Date(l.created_at).toLocaleString() : '—'}
                </td>
                <td className="mono">{l.action}</td>
                <td className="mono">
                  {l.resource_type}
                  {l.resource_id ? `:${String(l.resource_id).slice(0, 8)}` : ''}
                </td>
                <td className="mono">{l.actor_id ? String(l.actor_id).slice(0, 8) : '—'}</td>
                <td>{l.actor_role ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && !error && <div className="empty">No audit entries</div>}
      </div>
    </>
  );
}
