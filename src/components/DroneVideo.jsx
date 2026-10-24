import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { h264Supported, playH264 } from '../lib/h264Stream'
import StreamImg from './StreamImg'

const FIRST_FRAME_MS = 8000   // no H.264 picture by then: show MJPEG instead
const UPGRADE_MS = 15000      // while on MJPEG, how often to check whether H.264 became available
const MAX_H264_FAILS = 2      // H.264 that keeps failing here: stay on MJPEG

/**
 * The drone camera's live view. H.264 drawn into a <canvas> when the Pi sends
 * it (camera module) and this browser can decode it, otherwise the MJPEG
 * stream in an <img>. onLoad / onError work as on the <img>: onLoad when
 * pictures arrive, onError when there are none.
 */
export default function DroneVideo({ className, style, alt, onLoad, onError }) {
  const [mode, setMode] = useState(h264Supported() ? 'probe' : 'mjpeg')
  const canvasRef = useRef(null)
  const fails = useRef(0)
  const handlers = useRef({ onLoad, onError })
  handlers.current = { onLoad, onError }

  // Which stream the camera is sending now.
  useEffect(() => {
    if (mode !== 'probe') return
    let alive = true
    api.cameraStatus()
      .then((s) => { if (alive) setMode(s?.codec === 'h264' ? 'h264' : 'mjpeg') })
      .catch(() => { if (alive) setMode('mjpeg') })
    return () => { alive = false }
  }, [mode])

  useEffect(() => {
    if (mode !== 'h264') return
    let gotFrame = false
    const toMjpeg = (failed) => {
      if (failed) fails.current++
      setMode('mjpeg')
    }
    const player = playH264({
      url: api.h264Url(),
      canvas: canvasRef.current,
      onFirstFrame: () => { gotFrame = true; fails.current = 0; handlers.current.onLoad?.() },
      onFatal: (reason) => toMjpeg(reason === 'decode'),
    })
    const timer = setTimeout(() => { if (!gotFrame) { player.close(); toMjpeg(true) } }, FIRST_FRAME_MS)
    return () => { clearTimeout(timer); player.close() }
  }, [mode])

  // On MJPEG, switch to H.264 once the camera sends it (e.g. the webcam was unplugged).
  useEffect(() => {
    if (mode !== 'mjpeg' || !h264Supported() || fails.current >= MAX_H264_FAILS) return
    const t = setInterval(() => {
      api.cameraStatus().then((s) => { if (s?.codec === 'h264') setMode('h264') }).catch(() => {})
    }, UPGRADE_MS)
    return () => clearInterval(t)
  }, [mode])

  if (mode === 'mjpeg') {
    return <StreamImg src={api.streamUrl()} alt={alt} className={className} style={style} onLoad={onLoad} onError={onError} />
  }
  return <canvas ref={canvasRef} aria-label={alt} role="img" className={className} style={style} />
}
