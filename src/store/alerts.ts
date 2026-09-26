import { create } from 'zustand';
import type { Alert } from '../types/alert';

interface AlertState {
  alerts: Alert[];
  dismissAlert: (alertId: string) => void;
}

const initialAlerts: Alert[] = [
  {
    id: 'alert-001',
    title: 'Repeated failed sign-ins',
    severity: 'high',
    source: 'identity-gateway',
    createdAt: '2026-09-26T09:42:00Z',
    summary: 'Multiple authentication failures from a single source.',
  },
  {
    id: 'alert-002',
    title: 'Unusual outbound data volume',
    severity: 'medium',
    source: 'network-monitor',
    createdAt: '2026-09-26T09:18:00Z',
    summary: 'Outbound traffic exceeded the established baseline.',
  },
  {
    id: 'alert-003',
    title: 'Endpoint protection disabled',
    severity: 'critical',
    source: 'endpoint-agent',
    createdAt: '2026-09-26T08:56:00Z',
    summary: 'Protection was disabled on a managed workstation.',
  },
];

export const useAlertStore = create<AlertState>((set) => ({
  alerts: initialAlerts,
  dismissAlert: (alertId) =>
    set(({ alerts }) => ({
      alerts: alerts.filter((alert) => alert.id !== alertId),
    })),
}));
