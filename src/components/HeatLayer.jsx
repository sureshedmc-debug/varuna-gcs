import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet.heat'

// A thin react-leaflet wrapper around leaflet.heat. Follows the same
// "stable object" discipline as MapCanvas.jsx's icon cache: the L.heatLayer is
// created once per mount, and only its point set / options change over time.
// `points` = [[lat, lng, intensity], ...] as produced by hotspots.js's heatPoints().
export default function HeatLayer({ points = [], radius = 30, blur = 22, maxZoom = 18, minOpacity = 0.35 }) {
  const map = useMap()
  const ref = useRef(null)

  useEffect(() => {
    const layer = L.heatLayer(points, { radius, blur, maxZoom, minOpacity }).addTo(map)
    ref.current = layer
    return () => {
      map.removeLayer(layer)
      ref.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    ref.current?.setLatLngs(points || [])
  }, [points])

  useEffect(() => {
    ref.current?.setOptions({ radius, blur, maxZoom, minOpacity })
  }, [radius, blur, maxZoom, minOpacity])

  return null
}
