// Service worker for the installed VARUNA AI web app (website build only).
// It only steps in for page loads: if the network is down, the last copy of the
// app shell opens instead of the browser's error page. Everything else (the
// drone and boat backends, sign-in, video, WebSockets) goes straight to the
// network untouched.
const SHELL = 'varuna-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add('/index.html')).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.mode !== 'navigate' || req.method !== 'GET') return
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put('/index.html', copy))
        }
        return res
      })
      .catch(() => caches.match('/index.html')),
  )
})
