import { Link, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { AlertsPage } from '../features/alerts/AlertsPage';
import { AuthPage } from '../features/auth/AuthPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { InvestigationsPage } from '../features/investigations/InvestigationsPage';

function AppLayout() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink className="brand" to="/">
          SIEM Console
        </NavLink>
        <nav aria-label="Primary navigation" className="navigation">
          <NavLink end to="/">
            Overview
          </NavLink>
          <NavLink to="/alerts">Alerts</NavLink>
          <NavLink to="/investigations">Investigations</NavLink>
          <NavLink to="/auth">Sign in</NavLink>
        </nav>
      </header>
      <main className="page-content">
        <Outlet />
      </main>
    </div>
  );
}

function NotFoundPage() {
  return (
    <section className="route-panel">
      <h1>Page not found</h1>
      <p>The requested route does not exist.</p>
      <Link to="/">Return to overview</Link>
    </section>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route element={<DashboardPage />} index />
        <Route element={<AlertsPage />} path="alerts" />
        <Route element={<InvestigationsPage />} path="investigations" />
        <Route element={<AuthPage />} path="auth" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
