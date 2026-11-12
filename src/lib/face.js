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

/**
 * One look at the video: { faces, descriptor?, box? }. `descriptor` is set only
 * when exactly one face is clearly in view.
 */
export async function lookOnce(video) {
  const faceapi = await loadFace()
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
  const found = await faceapi.detectAllFaces(video, opts).withFaceLandmarks(true).withFaceDescriptors()
  if (found.length !== 1) return { faces: found.length }
  const d = found[0]
  return { faces: 1, descriptor: Array.from(d.descriptor, (x) => Math.round(x * 1e5) / 1e5), box: d.detection.box, score: d.detection.score }
}
