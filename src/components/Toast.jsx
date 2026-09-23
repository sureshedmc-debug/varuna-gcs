import { createContext, useCallback, useContext, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { StatusOrb } from './ui'

const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

let idc = 0

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])

  const push = useCallback((t) => {
    const id = ++idc
    const item = { id, level: 'ok', ttl: 5000, ...t }
    setItems((s) => [...s, item])
    if (item.ttl) setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), item.ttl)
  }, [])

  // Convenience: feed a backend {success, message} envelope straight in.
  const fromResult = useCallback(
    (res, okMsg) => {
      if (res && res.success === false) {
        push({ level: 'bad', title: 'Command rejected', msg: res.message || 'Failed' })
      } else if (res && res.message) {
        // Surface clamp notes / server messages even on success.
        push({ level: res.success === false ? 'bad' : 'ok', title: okMsg || 'OK', msg: res.message })
      } else {
        push({ level: 'ok', title: okMsg || 'Done' })
      }
      return res
    },
    [push]
  )

  const value = Object.assign(push, { push, fromResult })

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 24, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              className="glass pointer-events-auto flex w-full max-w-md items-start gap-3 px-4 py-3 shadow-elev"
            >
              <div className="mt-1">
                <StatusOrb level={t.level} size={12} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink">{t.title}</div>
                {t.msg && <div className="mt-0.5 break-words text-sm text-muted">{t.msg}</div>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}
