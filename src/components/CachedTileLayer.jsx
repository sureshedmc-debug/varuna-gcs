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

function revoke(src) {
  if (!src) return
  try {
    URL.revokeObjectURL(src)
  } catch {
    /* already gone */
  }
}

const CachedLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img')
    img.alt = ''
    img.setAttribute('role', 'presentation')

    const url = this.getTileUrl(coords)
    const k = tileKey(coords.z, coords.x, coords.y)
    const tileId = this._tileCoordsToKey(coords)
    let settled = false

    const show = (src, isObjectUrl) => {
      if (settled) return
      settled = true
      // Panning or zooming while this tile was still loading means Leaflet has
      // ALREADY dropped it and fired tileunload/tileabort - at which point
      // _varunaObjectUrl wasn't set yet, so the handler below found nothing to
      // revoke. Assigning a blob URL now would pin that Blob for the life of
      // the page, with nothing left to ever release it.
      if (isObjectUrl && !this._tiles[tileId]) {
        revoke(src)
        done(null, img)
        return
      }
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
    // BOTH events matter. Leaflet fires tileunload when a tile scrolls out of
    // view, but on a zoom change it calls _abortLoading, which fires
    // 'tileabort' instead - and a tile discarded there is exactly the case
    // where a blob URL was set but never released.
    const releaseTile = (e) => {
      const src = e.tile?._varunaObjectUrl
      if (!src) return
      revoke(src)
      e.tile._varunaObjectUrl = null
    }
    layer.on('tileunload', releaseTile)
    layer.on('tileabort', releaseTile)
    layer.addTo(map)
    layerRef.current = layer
    return () => {
      // Removing the layer does not unload each tile, so sweep whatever is
      // still held before dropping it.
      for (const t of Object.values(layer._tiles || {})) {
        if (t?.el?._varunaObjectUrl) {
          revoke(t.el._varunaObjectUrl)
          t.el._varunaObjectUrl = null
        }
      }
      layer.remove()
      layerRef.current = null
    }
    // options is a fresh object each render; the layer only needs rebuilding
    // when the tile source itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url, maxZoom])

  return null
}
