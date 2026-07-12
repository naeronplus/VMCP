import { useEffect, useState } from 'react';
import { api, type ErrorDef, type JobErrorRow } from '../api/client';

export function ErrorsPage() {
  const [catalog, setCatalog] = useState<ErrorDef[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<JobErrorRow[]>([]);

  useEffect(() => {
    void api.errorCatalog().then((r) => setCatalog(Object.values(r.catalog)));
  }, []);

  return (
    <>
      <div className="header">
        <h1>Error catalog & search</h1>
        <div className="row-actions">
          <input
            className="btn"
            placeholder="Full-text search job errors…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            className="btn primary"
            onClick={async () => {
              const r = await api.searchErrors(q);
              setHits(r.errors);
            }}
          >
            Search
          </button>
        </div>
      </div>
      {hits.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <strong>Search results</strong>
          </div>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Class</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{h.code}</td>
                  <td>{h.class}</td>
                  <td>{h.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Class</th>
              <th>Severity</th>
              <th>Operator action</th>
              <th>Docs</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((e) => (
              <tr key={e.code}>
                <td className="mono">{e.code}</td>
                <td>{e.class}</td>
                <td>
                  <span
                    className={`badge ${
                      e.severity === 'high' || e.severity === 'critical'
                        ? 'danger'
                        : e.severity === 'medium'
                          ? 'warn'
                          : 'info'
                    }`}
                  >
                    {e.severity}
                  </span>
                </td>
                <td>{e.operatorAction}</td>
                <td>
                  <a href={e.docsPath}>{e.docsPath}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
