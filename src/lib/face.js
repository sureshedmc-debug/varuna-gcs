// Face check for sign-in: finds the face in the webcam picture and turns it into
// a face template (128 numbers). Runs entirely on this computer with the models
// in /models/face (face-api, MIT). No photo is kept: only the template goes to
// the local store, which compares it with the one saved when the account was made.

const MODEL_URL = '/models/face'
// Templates taken per check, a moment apart: more when saving the face, so the
// saved one covers small changes of angle; two are enough to compare.
export const SAMPLES = { enroll: 3, verify: 2 }

let loading = null

/**
 * Load face-api and its three small models once, and run each model once on a
 * blank picture. That first run is what is slow (the graphics card builds its
 * programs, several seconds); done ahead of time, a real check takes ~0.1 s.
 */
export function loadFace() {
  loading ||= (async () => {
    const faceapi = await import('@vladmandic/face-api')
    // One GPU program per kind of step instead of one per picture size: the
    // first run drops from ~8 s to ~3 s.
    faceapi.tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true)
    await faceapi.tf.ready()
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
    const blank = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })
    await faceapi.detectAllFaces(blank(320, 240), new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
    await faceapi.detectFaceLandmarksTiny(blank(112, 112))
    await faceapi.computeFaceDescriptor(blank(150, 150))
    return faceapi
  })().catch((err) => {
    loading = null // let the next attempt try again
    throw err
  })
  return loading
}

/** Start loading in the background (sign-in page opened), so the check is instant. */
export function preloadFace() {
  loadFace().catch(() => {}) // the camera step reports it if it really fails
}

export class FaceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Open the front camera. Throws FaceError with a message an operator can act on. */
export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new FaceError('no_camera', 'This computer has no camera the app can use.')
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new FaceError('blocked', 'Camera access is blocked. Allow the camera for VARUNA and try again.')
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') throw new FaceError('no_camera', 'No camera found. Plug in a webcam and try again.')
    if (err.name === 'NotReadableError') throw new FaceError('busy', 'The camera is in use by another program (or another tab). Close it and try again.')
    throw new FaceError('camera', `Could not open the camera (${err.message || err.name}).`)
  }
}

// A copy of the frame with its contrast stretched, reused between looks.
let boost = null

/**
 * The frame with its darkest 1% mapped to black and brightest 1% to white.
 * A dim room or a grainy laptop webcam leaves the face too flat for the
 * detector: measured on the same face, the score fell from 0.84 to 0.22 in a
 * darker picture (needed: 0.5), and this brings it back to ~0.68. The face
 * template from it still matches the one saved from a normal picture
 * (distance 0.18-0.26, limit 0.5) while another person stays at ~0.70.
 */
function stretched(video) {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  boost ||= document.createElement('canvas')
  if (boost.width !== w || boost.height !== h) Object.assign(boost, { width: w, height: h })
  const g = boost.getContext('2d', { willReadFrequently: true })
  g.drawImage(video, 0, 0, w, h)
  const img = g.getImageData(0, 0, w, h)
  const p = img.data
  const hist = new Uint32Array(256)
  for (let i = 0; i < p.length; i += 4) hist[(p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0]++
  const n = p.length / 4
  let lo = -1
  let hi = 255
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v]
    if (lo < 0 && acc > n * 0.01) lo = v
    if (acc >= n * 0.99) {
      hi = v
      break
    }
  }
  const k = 255 / Math.max(16, hi - lo) // never amplify a near-flat (covered) picture into noise
  for (let i = 0; i < p.length; i += 4) {
    p[i] = (p[i] - lo) * k
    p[i + 1] = (p[i + 1] - lo) * k
    p[i + 2] = (p[i + 2] - lo) * k
  }
  g.putImageData(img, 0, 0)
  return boost
}

/**
 * One look at the video: { faces, descriptor?, box? }. `descriptor` is set only
 * when exactly one face is clearly in view. If the picture as it is shows no
 * face, it looks again at a contrast-stretched copy (see stretched()), with the
 * same bar for what counts as a face.
 */
export async function lookOnce(video) {
  const faceapi = await loadFace()
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
  const detect = (input) => faceapi.detectAllFaces(input, opts).withFaceLandmarks(true).withFaceDescriptors()
  let found = await detect(video)
  if (found.length === 0) {
    const brighter = stretched(video)
    if (brighter) found = await detect(brighter)
  }
  if (found.length !== 1) return { faces: found.length }
  const d = found[0]
  return { faces: 1, descriptor: Array.from(d.descriptor, (x) => Math.round(x * 1e5) / 1e5), box: d.detection.box, score: d.detection.score }
}
