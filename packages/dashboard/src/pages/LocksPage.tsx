import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type LockHistoryEntry,
  type LockRow,
} from '../api/client';
import { usePgosWebSocket } from '../hooks/usePgosWebSocket';

export function LocksPage({ role }: { role: string }) {
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<LockHistoryEntry[]>([]);

  const refresh = useCallback(async () => {
    const r = await api.locks();
    setLocks(r.locks);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    });
  }, [refresh]);

  usePgosWebSocket({
    projectIds: [],
    onEvent: (ev) => {
      if (ev.type === 'job.updated' || ev.type === 'lock.updated') {
        void refresh();
      }
    },
  });

  async function loadHistory(lockKey: string) {
    setError('');
    try {
      const r = await api.lockHistory(lockKey);
      setHistoryKey(lockKey);
      setHistory(r.history);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    }
  }

  return (
    <>
      <div className="header">
        <h1>Distributed locks</h1>
        <span className="muted">Redis source of truth · Postgres fencing ledger · live</span>
      </div>
      {error && <div className="error-text">{error}</div>}
      {msg && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Owner</th>
              <th>Fencing token</th>
              <th>Health</th>
              <th>TTL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {locks.map((l) => (
              <tr key={l.lockKey}>
                <td className="mono">{l.lockKey}</td>
                <td className="mono">{l.ownerId}</td>
                <td className="mono">{l.fencingToken}</td>
                <td>
                  <span className={`badge ${l.health === 'healthy' ? 'ok' : 'warn'}`}>
                    {l.health}
                  </span>
                </td>
                <td>{l.ttlSeconds}s</td>
                <td className="row-actions">
                  <button type="button" className="btn" onClick={() => void loadHistory(l.lockKey)}>
                    History
                  </button>
                  {role === 'admin' && (
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const reason = prompt('Reclaim reason?') ?? '';
                        if (!reason) return;
                        try {
                          await api.reclaimLock(l.lockKey, reason);
                          setMsg(
                            `Reclaimed ${l.lockKey} — workers with old token get 403`,
                          );
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
                      Force reclaim
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {locks.length === 0 && <div className="empty">No active locks</div>}
      </div>

      {historyKey && (
        <div className="panel" style={{ marginTop: '1rem' }}>
          <div className="panel-header">
            <strong>Fencing history · {historyKey}</strong>
            <button type="button" className="btn" onClick={() => setHistoryKey(null)}>
              Close
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Acquired</th>
                <th>Reason</th>
                <th>Owner</th>
                <th>Token</th>
                <th>Released</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="muted">
                    {h.acquiredAt ? new Date(h.acquiredAt).toLocaleString() : '—'}
                  </td>
                  <td className="mono">{h.reason}</td>
                  <td className="mono">{h.owner}</td>
                  <td className="mono">{h.token?.slice(0, 24)}…</td>
                  <td className="muted">
                    {h.releasedAt ? new Date(h.releasedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length === 0 && <div className="empty">No history rows</div>}
        </div>
      )}
    </>
  );
}
