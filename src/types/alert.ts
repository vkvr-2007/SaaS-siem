export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Alert {
  id: string;
  title: string;
  severity: AlertSeverity;
  source: string;
  createdAt: string;
  summary: string;
}
