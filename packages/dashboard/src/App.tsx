import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client';
import { canAccess } from './lib/rbac';
import { PermissionDenied } from './components/PermissionDenied';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { JobsPage } from './pages/JobsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { LocksPage } from './pages/LocksPage';
import { DeadLetterPage } from './pages/DeadLetterPage';
import { TiersPage } from './pages/TiersPage';
import { ExtensionsPage } from './pages/ExtensionsPage';
import { ErrorsPage } from './pages/ErrorsPage';
import { DocsPage } from './pages/DocsPage';

export function App() {
  const [user, setUser] = useState<{ email: string; role: string } | null | undefined>(
    undefined,
  );

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div className="login-page muted">Loading…</div>;
  }

  if (!user) {
    return <LoginPage onLogin={(u) => setUser(u)} />;
  }

  const role = user.role;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          PGOS <span>Vibrato</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          {canAccess(role, '/projects') && <NavLink to="/projects">Projects</NavLink>}
          <NavLink to="/locks">Locks</NavLink>
          {canAccess(role, '/dead-letter') && (
            <NavLink to="/dead-letter">Dead letter</NavLink>
          )}
          <NavLink to="/tiers">Tiers & parity</NavLink>
          {canAccess(role, '/extensions') && (
            <NavLink to="/extensions">Extension approvals</NavLink>
          )}
          <NavLink to="/errors">Error catalog</NavLink>
          <NavLink to="/docs">AGENTS.md</NavLink>
        </nav>
        <div style={{ marginTop: 'auto', padding: '0.75rem' }}>
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {user.email}
          </div>
          <div className="badge info" style={{ marginTop: 6 }}>
            {user.role}
          </div>
          <button
            className="btn"
            style={{ marginTop: 12, width: '100%' }}
            onClick={async () => {
              await api.logout();
              setUser(null);
            }}
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/jobs" element={<JobsPage role={role} />} />
          <Route path="/projects" element={<ProjectsPage role={role} />} />
          <Route path="/locks" element={<LocksPage role={role} />} />
          <Route
            path="/dead-letter"
            element={
              canAccess(role, '/dead-letter') ? (
                <DeadLetterPage role={role} />
              ) : (
                <PermissionDenied resource="Dead letter queue" required="operator" />
              )
            }
          />
          <Route path="/tiers" element={<TiersPage />} />
          <Route
            path="/extensions"
            element={
              canAccess(role, '/extensions') ? (
                <ExtensionsPage role={role} />
              ) : (
                <PermissionDenied resource="Extension approvals" required="admin" />
              )
            }
          />
          <Route path="/errors" element={<ErrorsPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
