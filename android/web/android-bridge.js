// Added to index.html by scripts/build-android.mjs (Android build only).
//
// 1. window.varuna: the same bridge the desktop app exposes from its preload
//    script (electron/preload.cjs), answered by the app's own server
//    (android/nodejs-project/main.js) over same-origin HTTP.
// 2. Downloads: an Android WebView cannot save a blob: link by itself, so file
//    saves (reports, CSV exports, snapshots, recordings) are handed to the
//    shell, which writes them to the phone's Downloads folder.
;(function () {
  'use strict'
  var native = window.VarunaAndroid

  function call(path, address) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: String(address == null ? '' : address) }),
    }).then(function (r) { return r.json() })
  }

  window.varuna = {
    isDesktop: true, // same built-in proxy and local store as the desktop app
    isAndroid: true,
    getConfig: function () {
      return fetch('/local/android/config', { cache: 'no-store' }).then(function (r) { return r.json() })
    },
    setPiAddress: function (a) { return call('/local/android/pi/set', a) },
    testPiAddress: function (a) { return call('/local/android/pi/test', a) },
    setBoatAddress: function (a) { return call('/local/android/boat/set', a) },
    testBoatAddress: function (a) { return call('/local/android/boat/test', a) },
  }

  // ---- the desktop layout on a small screen ---------------------------------
  // The app is laid out for a ground-station screen (the desktop window is at
  // least 960 px wide). On a phone its panels would overlap, so the page is laid
  // out MIN_WIDTH px wide and scaled down to fit: the same UI, smaller. A screen
  // that is already that wide (a tablet in landscape) is left at its own size.
  var MIN_WIDTH = 1200
  var lastViewport = ''
  function fitViewport() {
    var view = 0
    try { view = native && native.viewWidthDp ? Number(native.viewWidthDp()) : 0 } catch (e) { view = 0 }
    if (!(view > 0)) view = window.screen.width
    var content = view < MIN_WIDTH
      ? 'width=' + MIN_WIDTH + ', viewport-fit=cover'
      : 'width=device-width, initial-scale=1.0, viewport-fit=cover'
    if (content === lastViewport) return
    var meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return // the shell calls again once the page has loaded
    meta.setAttribute('content', content)
    lastViewport = content
  }
  window.__varunaFitViewport = fitViewport // the shell calls it when the window changes size
  fitViewport()
  document.addEventListener('DOMContentLoaded', fitViewport)
  window.addEventListener('orientationchange', function () { setTimeout(fitViewport, 50) })

  // ---- the navigation rail on a touch screen --------------------------------
  // The rail slides away when the mouse moves off it. A finger has no "moving
  // off": after a tab is tapped it would stay open over the left of the screen
  // until the next tap elsewhere. Tell it the pointer has left.
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var nav = t.closest('[aria-label="Main navigation"]')
    if (!nav || !t.closest('button') || t.closest('.rail-iconbtn')) return // not the pin / close buttons
    setTimeout(function () {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: window.innerWidth, clientY: 0, bubbles: true }))
    }, 60)
  }, true)

  // ---- the intro can never be a dead end ------------------------------------
  // After the launch tap the intro plays a short 3D fly-in and then shows the
  // app. That fly-in is counted in rendered frames, so on a phone that is
  // drawing very slowly (a cold start right after an update) it can take far
  // longer than its 1.6 s, with nothing to tap meanwhile. If the intro is still
  // there 8 s after the tap, go straight into the app.
  var introTimer = 0
  document.addEventListener('click', function (e) {
    var t = e.target
    if (introTimer || !t || !t.closest || !t.closest('[aria-label="Launch VARUNA AI"]')) return
    introTimer = setTimeout(function () {
      if (!document.querySelector('[aria-label="Launch VARUNA AI"]')) return
      try { sessionStorage.setItem('varuna.entered', '1') } catch (err) { return }
      location.reload()
    }, 8000)
  }, true)

  // ---- videos after the app comes back ----------------------------------------
  // Chromium pauses a playing <video> when the app leaves the screen. Start the
  // ones that were playing again once the page is visible.
  var wasPlaying = []
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      wasPlaying = [].filter.call(document.querySelectorAll('video'), function (v) { return !v.paused && !v.ended })
      return
    }
    var list = wasPlaying
    wasPlaying = []
    ;[0, 400, 1500].forEach(function (ms) {
      setTimeout(function () {
        list.forEach(function (v) {
          if (!v.isConnected || !v.paused) return
          var p = v.play()
          if (p && p.catch) p.catch(function () {})
        })
      }, ms)
    })
  })

  if (!native || typeof native.saveBegin !== 'function') return

  // ---- saving files -------------------------------------------------------
  var CHUNK = 384 * 1024 // bytes per call across the bridge (base64 grows it by a third)

  function toBase64(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  function saveBlob(blob, name) {
    var id = native.saveBegin(String(name || 'download'), blob.type || 'application/octet-stream')
    if (!id) return Promise.resolve(false)
    var offset = 0
    function next() {
      if (offset >= blob.size) return Promise.resolve(native.saveEnd(id))
      var part = blob.slice(offset, offset + CHUNK)
      offset += CHUNK
      return part.arrayBuffer().then(function (buf) {
        if (!native.saveChunk(id, toBase64(new Uint8Array(buf)))) throw new Error('write failed')
        return next()
      })
    }
    return next().catch(function (err) {
      native.saveAbort(id, String((err && err.message) || err))
      return false
    })
  }

  function nameFromUrl(href) {
    try {
      var p = new URL(href, location.href).pathname.split('/').pop()
      return decodeURIComponent(p || '') || 'download'
    } catch (e) {
      return 'download'
    }
  }

  /** true if this link is a file save the shell should handle. */
  function wantsSave(a) {
    if (!a || !a.href) return false
    if (a.hasAttribute('download')) return true
    return /^(blob|data):/i.test(a.href) && a.target !== '_blank'
  }

  function saveLink(a) {
    var name = a.getAttribute('download') || nameFromUrl(a.href)
    // Fetch now: callers revoke their blob: URL right after click().
    return fetch(a.href)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.blob()
      })
      .then(function (blob) { return saveBlob(blob, name) })
      .catch(function (err) { native.saveFailed(name, String((err && err.message) || err)) })
  }

  // A download the page starts some other way (the shell's DownloadListener).
  window.__varunaSaveUrl = function (url, name) {
    var a = document.createElement('a')
    a.href = url
    if (name) a.setAttribute('download', name)
    saveLink(a)
  }

  // Links clicked by the operator…
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null
    if (!wantsSave(a) || e.defaultPrevented) return
    e.preventDefault()
    saveLink(a)
  }, true)

  // …and links the app clicks itself (an <a> that is never added to the page
  // does not reach the listener above).
  var realClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (wantsSave(this) && !this.isConnected) return void saveLink(this)
    return realClick.apply(this, arguments)
  }

  // The WebView has no print dialog of its own.
  if (typeof native.print === 'function') {
    window.print = function () { native.print() }
  }

  // ---- window.open -----------------------------------------------------------
  // Windows of the app itself (a camera snapshot, the certificate it writes
  // into a blank window) open on top, inside the app. Everything else (maps,
  // WhatsApp, and the Google / fingerprint sign-in pages on http://localhost,
  // which must run in a real browser) goes to another app. Deciding here, where
  // the address is known, means the shell never has to guess.
  var realOpen = window.open
  window.open = function (url, name, features) {
    var target = null
    try {
      if (url != null && String(url) !== '') target = new URL(String(url), location.href)
    } catch (e) {
      return null
    }
    var own = !target || target.origin === location.origin || /^(about|blob|data):$/.test(target.protocol)
    if (!own) {
      if (typeof native.openExternal !== 'function' || !native.openExternal(target.href)) return null
      if (/(^|,)\s*(noopener|noreferrer)\b/i.test(String(features || ''))) return null
      // What the caller needs from the window it "opened": to see that it is
      // still open, and to be able to close it (src/lib/fingerprint.js).
      return { closed: false, close: function () { this.closed = true }, focus: function () {}, blur: function () {}, postMessage: function () {} }
    }
    var w = realOpen.apply(window, arguments)
    try {
      // A window the app writes into has no bridge of its own: give its print()
      // the shell's dialog for that window.
      if (w && typeof native.printPopup === 'function') w.print = function () { native.printPopup() }
    } catch (e) {
      /* nothing to add */
    }
    return w
  }
})()
