import { classNames } from '../../lib/utils';

export type BadgeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface BadgeProps {
  severity: BadgeSeverity;
}

const severityClasses: Record<BadgeSeverity, string> = {
  critical: 'border-critical text-critical bg-critical-subtle',
  high: 'border-high text-high bg-high-subtle',
  medium: 'border-medium text-medium bg-medium-subtle',
  low: 'border-low text-low bg-low-subtle',
  info: 'border-info text-info bg-info-subtle',
};

export function Badge({ severity }: BadgeProps) {
  return (
    <span
      className={classNames(
        'inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase',
        severityClasses[severity],
      )}
      role="status"
    >
      {severity}
    </span>
  );
}
