import { useEffect, useState } from 'react';
import { api, type ApprovalRow } from '../api/client';

export function ExtensionsPage({ role }: { role: string }) {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);

  async function refresh() {
    const r = await api.approvals();
    setApprovals(r.approvals);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <div className="header">
        <h1>Extension network approvals</h1>
        <span className="muted">Network egress blocked until admin approval (§10.1)</span>
      </div>
      <div className="panel">
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
                        className="btn primary"
                        onClick={async () => {
                          await api.reviewApproval(a.id, 'approved');
                          await refresh();
                        }}
                      >
                        Approve
                      </button>
                      <button
                        className="btn"
                        onClick={async () => {
                          await api.reviewApproval(a.id, 'rejected');
                          await refresh();
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
        {approvals.length === 0 && <div className="empty">No pending approvals</div>}
      </div>
    </>
  );
}
