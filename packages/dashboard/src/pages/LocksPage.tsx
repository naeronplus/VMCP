import { useEffect, useState } from 'react';
import { api, type LockRow } from '../api/client';

export function LocksPage({ role }: { role: string }) {
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [msg, setMsg] = useState('');

  async function refresh() {
    const r = await api.locks();
    setLocks(r.locks);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <div className="header">
        <h1>Distributed locks</h1>
        <span className="muted">Redis source of truth · Postgres fencing ledger</span>
      </div>
      {msg && <div className="muted" style={{ marginBottom: 12 }}>{msg}</div>}
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
                  <span
                    className={`badge ${l.health === 'healthy' ? 'ok' : 'warn'}`}
                  >
                    {l.health}
                  </span>
                </td>
                <td>{l.ttlSeconds}s</td>
                <td>
                  {role === 'admin' && (
                    <button
                      className="btn"
                      onClick={async () => {
                        const reason = prompt('Reclaim reason?') ?? '';
                        if (!reason) return;
                        await api.reclaimLock(l.lockKey, reason);
                        setMsg(`Reclaimed ${l.lockKey} — workers with old token get 403`);
                        await refresh();
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
    </>
  );
}
