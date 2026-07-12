import { useEffect, useState } from 'react';

export function DocsPage() {
  const [md, setMd] = useState('Loading AGENTS.md…');

  useEffect(() => {
    void fetch('/api/v1/docs/agents.md', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load');
        return r.text();
      })
      .then(setMd)
      .catch(() =>
        setMd(
          '# AGENTS.md unavailable\n\nEnsure the orchestrator can read the monorepo AGENTS.md.',
        ),
      );
  }, []);

  return (
    <>
      <div className="header">
        <h1>Godot agent documentation</h1>
      </div>
      <div className="panel" style={{ padding: '1.25rem 1.5rem' }}>
        <pre
          className="mono"
          style={{ whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.5 }}
        >
          {md}
        </pre>
      </div>
    </>
  );
}
