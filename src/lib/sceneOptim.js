import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Bake every static mesh under `root` into one mesh per material, so a model
 * built from a hundred small parts costs a handful of draw calls. Meshes under
 * any object in `skip` (moving parts), with multi-materials, or with shader
 * materials (which may read object-space positions) are left alone.
 */
export function mergeStatic(root, skip = new Set()) {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const buckets = new Map()
  const victims = []
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o.material.isShaderMaterial) return
    for (let p = o; p && p !== root; p = p.parent) if (skip.has(p)) return
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld))
    const m = o.material
    const textured = !!(m.map || m.bumpMap || m.normalMap || m.roughnessMap || m.alphaMap || m.emissiveMap)
    const keep = ['position', 'normal', ...(textured ? ['uv'] : []), ...(m.vertexColors ? ['color'] : [])]
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name)
    g.morphAttributes = {}
    const sig = `${o.material.uuid}|${Object.keys(g.attributes).sort().join(',')}|${o.layers.mask}|${o.renderOrder}`
    if (!buckets.has(sig)) buckets.set(sig, { mat: o.material, layers: o.layers.mask, order: o.renderOrder, geos: [] })
    buckets.get(sig).geos.push(g)
    victims.push(o)
  })
  for (const o of victims) {
    o.removeFromParent()
    o.geometry.dispose()
  }
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false)
    b.geos.forEach((g) => g.dispose())
    if (!merged) continue
    const m = new THREE.Mesh(merged, b.mat)
    m.layers.mask = b.layers
    m.renderOrder = b.order
    root.add(m)
  }
}

/** Put small parts on `layer` (seen by the main camera only) so the mirror pass skips them. */
export function hideSmallFromMirror(root, layer, maxRadius) {
  root.traverse((o) => {
    if (!o.isMesh) return
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere()
    const s = o.getWorldScale(new THREE.Vector3())
    if (o.geometry.boundingSphere.radius * Math.max(s.x, s.y, s.z) < maxRadius) o.layers.set(layer)
  })
}
