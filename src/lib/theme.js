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

// Look: 'new' (navy / teal / violet, the default) | 'classic' (the earlier
// gold-and-black tabs with the soft purple/white Home). Independent of the
// theme above; driven by <html data-look="classic">.
export const LOOKS = ['new', 'classic']

export function getLook() {
  try {
    return localStorage.getItem('varuna.look') === 'classic' ? 'classic' : 'new'
  } catch {
    return 'new'
  }
}

export function applyLook(l) {
  if (l === 'classic') document.documentElement.setAttribute('data-look', 'classic')
  else document.documentElement.removeAttribute('data-look')
  try {
    localStorage.setItem('varuna.look', l === 'classic' ? 'classic' : 'new')
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent('varuna:look', { detail: l }))
}
