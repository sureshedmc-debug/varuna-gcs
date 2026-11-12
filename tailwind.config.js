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
        /* glow shadows follow the look: teal (new) or gold (classic), see index.css */
        glow: 'var(--shadow-glow)',
        elev: 'var(--shadow-elev)',
      },
      fontFeatureSettings: { tnum: '"tnum" 1' },
    },
  },
  plugins: [],
}
