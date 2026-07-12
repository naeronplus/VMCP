import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ApprovalRow,
  type ExtensionPolicyRow,
} from '../api/client';

export function ExtensionsPage({ role }: { role: string }) {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [policies, setPolicies] = useState<ExtensionPolicyRow[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [a, p] = await Promise.all([api.approvals(), api.listExtensions()]);
      setApprovals(a.approvals);
      setPolicies(p.policies);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="header">
        <h1>Extensions</h1>
        <span className="muted">
          Policies (GET /extensions) · network approvals blocked until admin sign-off
        </span>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="panel" style={{ marginBottom: '1rem' }}>
        <div className="panel-header">
          <strong>Registered policies</strong>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Network</th>
              <th>Domains</th>
              <th>Godot range</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.extension_id}>
                <td className="mono">{p.extension_id}</td>
                <td>{p.name}</td>
                <td>
                  <span className={`badge ${p.network_allowed ? 'ok' : 'warn'}`}>
                    {p.network_allowed ? 'allowed' : 'denied'}
                  </span>
                </td>
                <td className="mono muted">{(p.approved_domains ?? []).join(', ') || '—'}</td>
                <td className="mono">{p.godot_version_range ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {policies.length === 0 && !error && (
          <div className="empty">No extension policies registered</div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <strong>Pending network approvals</strong>
        </div>
        <table>
          <thead>
            <tr>
              <th>Extension</th>
              <th>Domains</th>
              <th>Reason</th>
              <th>Risk</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.extension_id}</td>
                <td className="mono">{a.requested_domains?.join(', ')}</td>
                <td>{a.reason}</td>
                <td className="muted">{a.risk_assessment}</td>
                <td className="row-actions">
                  {role === 'admin' && (
                    <>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={async () => {
                          try {
                            await api.reviewApproval(a.id, 'approved');
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
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={async () => {
                          try {
                            await api.reviewApproval(a.id, 'rejected');
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
                        Reject
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {approvals.length === 0 && !error && (
          <div className="empty">No pending approvals</div>
        )}
      </div>
    </>
  );
}
