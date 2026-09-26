import type { AlertSeverity } from '../../types/alert';

interface StatusBadgeProps {
  severity: AlertSeverity;
}

export function StatusBadge({ severity }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${severity}`}>{severity}</span>;
}
