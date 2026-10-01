import { Component } from 'react'

const styles = {
  wrapper: {
    minHeight: '50vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  },
  card: {
    background: 'var(--hd-panel, #ffffff)',
    borderRadius: '16px',
    padding: '32px',
    maxWidth: '360px',
    width: '100%',
    border: '2px solid rgba(245,158,11,0.4)',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    textAlign: 'center',
  },
  iconCircle: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    background: 'rgba(245,158,11,0.12)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
  },
  title: {
    color: 'var(--hd-text, #111827)',
    fontWeight: '700',
    fontSize: '17px',
    marginBottom: '8px',
    lineHeight: '1.4',
  },
  errorSnippet: {
    color: 'var(--hd-muted, #6b7280)',
    fontSize: '13px',
    lineHeight: '1.5',
    marginBottom: '24px',
    wordBreak: 'break-word',
  },
  retryBtn: {
    background: '#0ea5a4',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 24px',
    fontWeight: '700',
    fontSize: '14px',
    cursor: 'pointer',
    outline: 'none',
  },
}

const WarningIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 2.25L1.5 21.75h21L12 2.25z"
      stroke="#f59e0b"
      strokeWidth="1.75"
      strokeLinejoin="round"
      fill="rgba(245,158,11,0.15)"
    />
    <line x1="12" y1="9" x2="12" y2="14" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="17.5" r="1" fill="#f59e0b" />
  </svg>
)

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
    this.handleRetry = this.handleRetry.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Log for debugging without crashing
    console.error('[ErrorBoundary] caught:', error, info)
  }

  handleRetry() {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  render() {
    const { hasError, error } = this.state
    const { fallback, children } = this.props

    if (!hasError) return children

    if (fallback) return fallback

    const message = error?.message ?? String(error ?? 'Unknown error')
    const snippet = message.length > 120 ? message.slice(0, 120) + '…' : message

    return (
      <div style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.iconCircle}>
            <WarningIcon />
          </div>
          <p style={styles.title}>This tab failed to load</p>
          <p style={styles.errorSnippet}>{snippet}</p>
          <button style={styles.retryBtn} onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
