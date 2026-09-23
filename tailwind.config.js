/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Theme-driven via CSS variables (see index.css). Switchable at runtime
        // between dark (blue accent) and light (cyan/sky accent).
        base: 'var(--base)',
        panel: 'var(--panel)',
        ink: 'rgb(var(--ink) / <alpha-value>)', // primary text
        muted: 'var(--muted)', // secondary text
        faint: 'var(--faint)', // tertiary
        accent: 'rgb(var(--accent) / <alpha-value>)', // blue (dark) / cyan (light)
        accent2: 'var(--accent2)',
        mint: '#32D74B', // status colours are fixed across themes
        ok: '#32D74B',
        warn: '#FF9F0A',
        bad: '#FF453A',
        line: 'var(--line)',
        chip: 'var(--chip)',
        chip2: 'var(--chip2)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      backdropBlur: { xs: '2px' },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--accent) / 0.3), 0 12px 44px -10px rgb(var(--accent) / 0.35)',
        elev: '0 18px 50px -18px rgba(0,0,0,0.5)',
      },
      fontFeatureSettings: { tnum: '"tnum" 1' },
    },
  },
  plugins: [],
}
