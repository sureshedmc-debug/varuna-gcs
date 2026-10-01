// Runtime theme: 'dark' (default) | 'light' | 'green' (pastel green forest).
// Driven by CSS variables on <html data-theme>. See index.css.

export const THEMES = ['dark', 'green', 'light']

export function getTheme() {
  try {
    const saved = localStorage.getItem('varuna.theme')
    if (saved === 'dark' || saved === 'green' || saved === 'light') return saved
    return 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(t) {
  if (t === 'light' || t === 'green') {
    document.documentElement.setAttribute('data-theme', t)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
  document.documentElement.style.colorScheme = t === 'dark' ? 'dark' : 'light'
  try {
    localStorage.setItem('varuna.theme', t)
  } catch {
    /* private mode */
  }
}
