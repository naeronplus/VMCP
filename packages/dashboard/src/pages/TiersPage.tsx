import { useEffect, useState } from 'react';
import { api, type ParityRow, type TierRow } from '../api/client';

export function TiersPage() {
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [parity, setParity] = useState<ParityRow[]>([]);

  useEffect(() => {
    void Promise.all([api.tiers(), api.parity()]).then(([t, p]) => {
      setTiers(t.tiers);
      setParity(p.checks);
    });
  }, []);

  return (
    <>
      <div className="header">
        <h1>Worker tiers & parity</h1>
        <span className="muted">Tier A self-hosted · Tier B GitHub-hosted · hourly canary</span>
      </div>
      <div className="card-grid">
        {tiers.map((t) => (
          <div className="card" key={t.tier}>
            <div className="label">Tier {t.tier}</div>
            <div className="value">{t.enabled ? (t.degraded ? 'DEGRADED' : 'OK') : 'OFF'}</div>
            <div className="muted mono" style={{ marginTop: 8 }}>
              cold-start avg: {t.avg_cold_start_ms ?? '—'} ms
            </div>
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
              <th>Passed</th>
              <th>Tier A</th>
              <th>Tier B</th>
            </tr>
          </thead>
          <tbody>
            {parity.map((c) => (
              <tr key={c.id}>
                <td className="muted">{new Date(c.created_at).toLocaleString()}</td>
                <td>
                  <span className={`badge ${c.passed ? 'ok' : 'danger'}`}>
                    {c.passed ? 'PASS' : 'FAIL'}
                  </span>
                </td>
                <td className="mono">{c.tier_a_checksum.slice(0, 12)}</td>
                <td className="mono">{c.tier_b_checksum.slice(0, 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {parity.length === 0 && <div className="empty">No parity results yet</div>}
      </div>
    </>
  );
}
