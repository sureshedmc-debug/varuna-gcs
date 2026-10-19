import { useEffect, useRef } from 'react'

// Chrome keeps downloading an MJPEG stream from an <img> after it leaves the
// page. Every visit to a video tab used to leave one more full-rate stream
// running until the Wi-Fi was full and the picture lagged by seconds.
// Pointing the image at an empty data URL closes the connection.
const NO_STREAM = 'data:,'

export function releaseStream(img) {
  if (img) img.src = NO_STREAM
}

/** An <img> for a /video_feed stream that closes the stream when it unmounts. */
export default function StreamImg({ src, ...props }) {
  const ref = useRef(null)
  useEffect(() => {
    // Read now: React clears ref.current before this cleanup runs.
    const img = ref.current
    // Set here, not as a prop: after a release React would not set it again.
    img.src = src
    return () => releaseStream(img)
  }, [src])
  return <img ref={ref} {...props} />
}
