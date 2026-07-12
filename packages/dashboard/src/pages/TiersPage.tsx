import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ParityRow, type TierRow } from '../api/client';
import { usePgosWebSocket } from '../hooks/usePgosWebSocket';

export function TiersPage({ role = 'viewer' }: { role?: string }) {
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [parity, setParity] = useState<ParityRow[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const isAdmin = role === 'admin';

  const refresh = useCallback(async () => {
    const [t, p] = await Promise.all([api.tiers(), api.parity()]);
    setTiers(t.tiers);
    setParity(p.checks);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    });
  }, [refresh]);

  usePgosWebSocket({
    projectIds: [],
    onEvent: (ev) => {
      if (
        ev.type === 'job.updated' ||
        ev.type === 'tier.updated' ||
        ev.type === 'parity.updated'
      ) {
        void refresh();
      }
    },
  });

  async function toggleTier(tier: string, enabled: boolean) {
    if (tier !== 'A' && tier !== 'B') return;
    setError('');
    setMsg('');
    try {
      await api.enableTier(tier, enabled);
      setMsg(`Tier ${tier} ${enabled ? 'enabled' : 'disabled'}`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code ?? e.status}: ${e.message}` : String(e));
    }
  }

  return (
    <>
      <div className="header">
        <h1>Worker tiers & parity</h1>
        <span className="muted">
          Tier A self-hosted · Tier B GitHub-hosted · hourly canary · live
        </span>
      </div>
      {error && <div className="error-text">{error}</div>}
      {msg && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}
      <div className="card-grid">
        {tiers.map((t) => (
          <div className="card" key={t.tier}>
            <div className="label">Tier {t.tier}</div>
            <div className="value">{t.enabled ? (t.degraded ? 'DEGRADED' : 'OK') : 'OFF'}</div>
            <div className="muted mono" style={{ marginTop: 8 }}>
              cold-start avg: {t.avg_cold_start_ms ?? '—'} ms
            </div>
            {t.tier === 'B' && (
              <div className="muted mono" style={{ marginTop: 6, fontSize: 12 }}>
                runner online:{' '}
                {t.tier_b_runner_online == null
                  ? '—'
                  : t.tier_b_runner_online
                    ? 'yes'
                    : 'no'}
                {' · '}
                godot cache:{' '}
                {t.godot_cache_warm == null
                  ? '—'
                  : t.godot_cache_warm
                    ? 'warm'
                    : 'cold'}
                {t.probe_source ? ` · src=${t.probe_source}` : ''}
              </div>
            )}
            {isAdmin && (t.tier === 'A' || t.tier === 'B') && (
              <button
                type="button"
                className="btn"
                style={{ marginTop: 10 }}
                onClick={() => void toggleTier(t.tier, !t.enabled)}
              >
                {t.enabled ? 'Disable' : 'Enable'} tier
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-header">
          <strong>Parity checks</strong>
        </div>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Result</th>
              <th>Reason</th>
              <th>Tier A</th>
              <th>Tier B</th>
            </tr>
          </thead>
          <tbody>
            {parity.map((c) => (
              <tr key={c.id}>
                <td className="muted">{new Date(c.created_at).toLocaleString()}</td>
                <td>
                  {c.skipped ? (
                    <span className="badge warn">SKIP</span>
                  ) : (
                    <span className={`badge ${c.passed ? 'ok' : 'danger'}`}>
                      {c.passed ? 'PASS' : 'FAIL'}
                    </span>
                  )}
                </td>
                <td className="muted mono">{c.reason ?? (c.skipped ? 'skipped' : '—')}</td>
                <td className="mono">{(c.tier_a_checksum ?? '').slice(0, 12)}</td>
                <td className="mono">{(c.tier_b_checksum ?? '').slice(0, 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {parity.length === 0 && <div className="empty">No parity results yet</div>}
      </div>
    </>
  );
}
