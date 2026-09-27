// A drop-in replacement for react-leaflet's <TileLayer> that keeps every tile
// it draws in IndexedDB and serves it from there next time — including with
// no connection at all. See src/lib/tileCache.js for the store itself.
//
// The important property is that it degrades to an ordinary TileLayer: if
// IndexedDB is unavailable, or the tile host refuses the cross-origin fetch,
// the tile is loaded with a plain <img src> exactly as before. Caching is
// opportunistic, never load-bearing.

import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { getTile, putTile, tileKey } from '../lib/tileCache'

const CachedLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img')
    img.alt = ''
    img.setAttribute('role', 'presentation')

    const url = this.getTileUrl(coords)
    const k = tileKey(coords.z, coords.x, coords.y)
    let settled = false

    const show = (src, isObjectUrl) => {
      if (settled) return
      settled = true
      if (isObjectUrl) img._varunaObjectUrl = src
      img.onload = () => done(null, img)
      img.onerror = () => done(new Error('tile load failed'), img)
      img.src = src
    }
    const direct = () => show(url, false)

    getTile(k)
      .then((blob) => {
        if (blob) return show(URL.createObjectURL(blob), true)
        // Not cached yet — fetch it as a blob so a copy can be kept. If the
        // host doesn't allow the cross-origin read, fall straight back to a
        // normal image load; the map still works, it just isn't cached.
        return fetch(url, { mode: 'cors', cache: 'default' })
          .then((res) => {
            if (!res.ok) throw new Error(String(res.status))
            return res.blob()
          })
          .then((b) => {
            putTile(k, b)
            show(URL.createObjectURL(b), true)
          })
          .catch(direct)
      })
      .catch(direct)

    return img
  },
})

/**
 * @param {string} url   tile URL template, e.g. '…/{z}/{y}/{x}'
 * @param {number} maxZoom
 */
export default function CachedTileLayer({ url, maxZoom = 19, ...options }) {
  const map = useMap()
  const layerRef = useRef(null)

  useEffect(() => {
    const layer = new CachedLayer(url, { maxZoom, ...options })
    // Object URLs would leak as the operator pans; release each one when
    // Leaflet drops the tile.
    layer.on('tileunload', (e) => {
      const src = e.tile?._varunaObjectUrl
      if (src) {
        try {
          URL.revokeObjectURL(src)
        } catch {
          /* already gone */
        }
        e.tile._varunaObjectUrl = null
      }
    })
    layer.addTo(map)
    layerRef.current = layer
    return () => {
      layer.remove()
      layerRef.current = null
    }
    // options is a fresh object each render; the layer only needs rebuilding
    // when the tile source itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url, maxZoom])

  return null
}
