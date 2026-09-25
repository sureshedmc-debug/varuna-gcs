// Records video of the Live-tab AI view (the boxed frames, exactly what the
// operator saw) every time detection runs, in either Webcam or Drone-feed
// mode. Each Start→Stop run becomes one clip; switching source or restarting
// detection starts a new clip instead of overwriting the last, so the whole
// mission is kept. Clips live in memory only (far too big for localStorage):
// they last for this browser tab's session and are downloaded alongside the
// Word report when one is generated.

import { useEffect, useState } from 'react'

const subs = new Set()
let state = { clips: [], recording: false, startedAt: 0 } // clips: [{ blob, startedAt, durationMs }]
let recorder = null
let chunks = []

function emit() {
  subs.forEach((fn) => fn(state))
}

/** Begin a new clip from the given MediaStream (e.g. canvas.captureStream()). */
export function startMissionRecording(stream) {
  if (recorder && recorder.state !== 'inactive') return // already recording
  chunks = []
  // VP8 first: same .webm file, far cheaper to encode than VP9, so recording doesn't make the app lag.
  const mimeType = ['video/webm; codecs=vp8', 'video/webm; codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || 'video/webm'
  let rec
  try {
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 })
  } catch {
    return
  }
  const startedAt = Date.now()
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' })
    chunks = []
    const clips = blob.size > 0 ? [...state.clips, { blob, startedAt, durationMs: Date.now() - startedAt }] : state.clips
    state = { clips, recording: false, startedAt: 0 }
    emit()
  }
  recorder = rec
  rec.start(1000) // 1s chunks so nothing recorded so far is lost if the tab hiccups
  state = { ...state, recording: true, startedAt }
  emit()
}

/** Stop the current clip; it's added to the clip list shortly after (async onstop). */
export function stopMissionRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  recorder = null
}

export function getMissionRecording() {
  return state
}

export function clearMissionRecording() {
  state = { ...state, clips: [] }
  emit()
}

/** A still JPEG from the latest clip, for the report's "Mission Video" section.
 *  A MediaRecorder-produced webm often reports an unknown/non-finite duration in
 *  Chrome, so this doesn't seek to the end — it grabs the frame shown shortly
 *  after playback starts, which is good enough for a poster. */
export function captureMissionPoster() {
  return new Promise((resolve) => {
    const last = state.clips[state.clips.length - 1]
    if (!last) return resolve(null)
    const url = URL.createObjectURL(last.blob)
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.src = url
    let done = false
    const finish = (dataUrl) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      resolve(dataUrl)
    }
    const grab = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = v.videoWidth || 480
        cv.height = v.videoHeight || 270
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height)
        finish(cv.toDataURL('image/jpeg', 0.7))
      } catch {
        finish(null)
      }
    }
    v.onerror = () => finish(null)
    v.onloadeddata = () => {
      v.play()
        .then(() => setTimeout(() => { v.pause(); grab() }, 150))
        .catch(grab) // autoplay blocked — grab whatever frame is loaded
    }
    setTimeout(() => finish(null), 4000) // never hang the report on a bad video
  })
}

export function useMissionRecording() {
  const [v, setV] = useState(state)
  useEffect(() => {
    setV(state) // catch any change between first render and subscribing
    subs.add(setV)
    return () => subs.delete(setV)
  }, [])
  return v
}
