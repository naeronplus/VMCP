import { useEffect, useState } from 'react';
import { api, ApiError, type DeadLetterRow } from '../api/client';

export function DeadLetterPage({ role }: { role: string }) {
  const [items, setItems] = useState<DeadLetterRow[]>([]);
  const [error, setError] = useState('');

  async function refresh() {
    setError('');
    try {
      const r = await api.deadLetter();
      setItems(r.items);
    } catch (e) {
      setError(
        e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e),
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <div className="header">
        <h1>Dead-letter queue</h1>
        <span className="muted">Escalates at 24h (project admin) and 72h (system admin)</span>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Reason</th>
              <th>Attempts</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.job_id}>
                <td className="mono">{i.job_id}</td>
                <td>{i.reason}</td>
                <td>{i.attempts}</td>
                <td className="muted">{new Date(i.created_at).toLocaleString()}</td>
                <td>
                  {(role === 'admin' || role === 'operator') && (
                    <button
                      className="btn primary"
                      onClick={async () => {
                        try {
                          await api.retryDeadLetter(i.job_id);
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
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && !error && <div className="empty">Queue empty</div>}
      </div>
    </>
  );
}
