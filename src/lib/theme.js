// Runtime theme: 'dark' (default, blue accent) or 'light' (sky + cyan accent).
// Driven by CSS variables on <html data-theme>. See index.css.

export function getTheme() {
  try {
    return localStorage.getItem('varuna.theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark'
  try {
    localStorage.setItem('varuna.theme', t)
  } catch {
    /* private mode */
  }
}
