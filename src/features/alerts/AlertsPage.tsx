import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useAlertStore } from '../../store/alerts';

export function AlertsPage() {
  useDocumentTitle('Alerts');
  const alerts = useAlertStore((state) => state.alerts);
  const dismissAlert = useAlertStore((state) => state.dismissAlert);

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Detection queue</p>
        <h1>Alerts</h1>
        <p className="page-description">Review and triage signals from monitored systems.</p>
      </header>
      {alerts.length > 0 ? (
        <div aria-label="Open alerts" className="alert-list">
          {alerts.map((alert) => (
            <article className="alert-row" key={alert.id}>
              <div>
                <h2 className="alert-title">{alert.title}</h2>
                <p className="alert-meta">
                  {alert.source} · {new Date(alert.createdAt).toLocaleString()}
                </p>
              </div>
              <StatusBadge severity={alert.severity} />
              <Button onClick={() => dismissAlert(alert.id)} type="button">
                Dismiss
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-state">No open alerts. Your queue is clear.</p>
      )}
    </section>
  );
}
