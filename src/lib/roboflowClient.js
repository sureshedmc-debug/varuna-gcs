/**
 * Roboflow Hosted Inference API Client for Varuna GCS.
 * Allows running cloud/serverless detections via Roboflow API.
 */

export const ROBOFLOW_CONFIG = {
  apiUrl: 'https://detect.roboflow.com',
  apiKey: 'cLh4d3Wn5J3CuLueqMQl',
  modelId: 'trash-detection-lxdwh/9',
}

/**
 * Perform inference on an HTML video, image, or canvas element using Roboflow hosted API.
 * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
 * @param {object} options
 * @returns {Promise<Array<{x1: number, y1: number, x2: number, y2: number, score: number, class: string, label: string}>>}
 */
export async function detectRoboflow(source, { confThr = 0.35 } = {}) {
  const sw = source.videoWidth || source.width || source.naturalWidth
  const sh = source.videoHeight || source.height || source.naturalHeight
  if (!sw || !sh) return []

  // Draw current frame to temporary canvas
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0, sw, sh)

  // Get base64 string without data:image/jpeg;base64, prefix
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  const base64Data = dataUrl.split(',')[1]

  const endpoint = `${ROBOFLOW_CONFIG.apiUrl}/${ROBOFLOW_CONFIG.modelId}?api_key=${ROBOFLOW_CONFIG.apiKey}&confidence=${Math.round(confThr * 100)}`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: base64Data,
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Roboflow API error (${res.status}): ${errText}`)
  }

  const json = await res.json()
  const predictions = json.predictions || []

  // Format predictions into standardized bounding box coordinates
  return predictions.map((p) => {
    const x1 = Math.max(0, p.x - p.width / 2)
    const y1 = Math.max(0, p.y - p.height / 2)
    const x2 = Math.min(sw, p.x + p.width / 2)
    const y2 = Math.min(sh, p.y + p.height / 2)
    return {
      x1,
      y1,
      x2,
      y2,
      score: p.confidence,
      class: p.class,
      label: p.class ? (p.class.charAt(0).toUpperCase() + p.class.slice(1)) : 'Trash',
      color: '#3B9EFF',
    }
  })
}
