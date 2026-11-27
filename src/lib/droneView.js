// The drone camera WITH its AI boxes, as the background drone detector draws it
// (components/BackgroundDetect.jsx -> WebcamDetect, off screen). The Boat tab
// mirrors that canvas, so it shows the drone's live view and what its AI finds
// without opening a second video stream or running a second detector.

let canvas = null
let lastFrame = 0

export function setDroneCanvas(c) {
  canvas = c || null
  if (!c) lastFrame = 0
}

export function getDroneCanvas() {
  return canvas
}

/** Called by the detector each time it has drawn a new picture. */
export function markDroneFrame() {
  lastFrame = performance.now()
}

/** ms since the detector last drew a picture (Infinity: never). */
export function droneFrameAge() {
  return lastFrame ? performance.now() - lastFrame : Infinity
}
