import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useAlertStore } from '../../store/alerts';

export function DashboardPage() {
  useDocumentTitle('Overview');
  const alerts = useAlertStore((state) => state.alerts);
  const criticalCount = alerts.filter((alert) => alert.severity === 'critical').length;

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Security operations</p>
        <h1>Overview</h1>
        <p className="page-description">Current signal across your monitored environment.</p>
      </header>
      <dl aria-label="Security metrics" className="metrics">
        <div className="metric">
          <dt>Open alerts</dt>
          <dd>{alerts.length}</dd>
        </div>
        <div className="metric">
          <dt>Critical alerts</dt>
          <dd>{criticalCount}</dd>
        </div>
        <div className="metric">
          <dt>Active investigations</dt>
          <dd>0</dd>
        </div>
      </dl>
      <h2 className="section-title">Latest activity</h2>
      <p className="empty-state">
        {alerts.length > 0
          ? `${alerts.length} alerts are awaiting review.`
          : 'No open alerts. Your queue is clear.'}
      </p>
    </section>
  );
}
