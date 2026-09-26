import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        critical: 'var(--color-critical)',
        high: 'var(--color-high)',
        medium: 'var(--color-medium)',
        low: 'var(--color-low)',
        info: 'var(--color-info)',
        'bg-primary': 'var(--color-bg-primary)',
        'bg-elevated': 'var(--color-bg-elevated)',
        'border-subtle': 'var(--color-border-subtle)',
        'critical-subtle': 'color-mix(in srgb, var(--color-critical) 16%, transparent)',
        'high-subtle': 'color-mix(in srgb, var(--color-high) 16%, transparent)',
        'medium-subtle': 'color-mix(in srgb, var(--color-medium) 16%, transparent)',
        'low-subtle': 'color-mix(in srgb, var(--color-low) 16%, transparent)',
        'info-subtle': 'color-mix(in srgb, var(--color-info) 16%, transparent)',
      },
    },
  },
  plugins: [],
} satisfies Config;
