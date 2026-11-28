// Small shared pieces of the VARUNA Assistant UI (dock pop-ups, Boat Vision feed).
const LEVEL_ICON = {
  ok: <path d="M5 12.5l4.2 4.2L19 7" />,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  bad: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
}
export const KIND_WHO = { reply: 'VARUNA', assistant: 'VARUNA', captain: 'AI captain', camera: 'Boat camera', live: 'Boat', ops: 'Boat', drive: 'Boat', boat: 'Boat' }
export const kindLabel = (k) => KIND_WHO[k] || 'Boat'

export function LevelIcon({ level, size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{LEVEL_ICON[level] || LEVEL_ICON.info}</svg>
  )
}
