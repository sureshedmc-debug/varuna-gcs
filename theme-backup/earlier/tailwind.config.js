/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        base:    'var(--base)',
        panel:   'var(--panel)',
        ink:     'rgb(var(--ink) / <alpha-value>)',
        muted:   'var(--muted)',
        faint:   'var(--faint)',
        accent:  'rgb(var(--accent) / <alpha-value>)',
        accent2: 'var(--accent2)',
        mint:    '#32D74B',
        ok:      '#32D74B',
        warn:    '#FF9F0A',
        bad:     '#FF453A',
        line:    'var(--line)',
        chip:    'var(--chip)',
        chip2:   'var(--chip2)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      backdropBlur: { xs: '2px' },
      boxShadow: {
        /* gold glow shadow — used by TiltCard, CommandPanel etc */
        glow: '0 0 0 1px rgba(212,160,23,0.35), 0 0 28px rgba(212,160,23,0.20), 0 12px 44px -10px rgba(212,160,23,0.15)',
        elev: '0 20px 60px -20px rgba(0,0,0,0.9), inset 0 1px 0 rgba(245,200,66,0.22)',
      },
      fontFeatureSettings: { tnum: '"tnum" 1' },
    },
  },
  plugins: [],
}
