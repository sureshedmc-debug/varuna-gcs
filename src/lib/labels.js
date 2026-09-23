// Canonicalise the detector's raw label to ONLY the two classes we surface:
// 'plastic bottle' and 'trash'. Everything else (person, car, animal, …) → null
// and is dropped from the output.

const BOTTLE = ['plastic bottle', 'water bottle', 'pet bottle', 'soda bottle', 'bottle']
const TRASH = [
  'trash', 'garbage', 'litter', 'waste', 'rubbish', 'debris', 'item',
  'plastic', 'plastic bag', 'bag', 'wrapper', 'wrapping',
  'can', 'tin can', 'aluminium can', 'aluminum can', 'soda can',
  'cup', 'container', 'packaging', 'packaged goods', 'carton', 'box',
  'styrofoam', 'foam', 'straw', 'polythene', 'pollution',
]

// River-specific garbage terms
const RIVER_TRASH = [
  ...TRASH,
  'river trash', 'river garbage', 'floating trash', 'floating garbage',
  'water trash', 'marine litter', 'marine debris', 'floating debris',
  'floating plastic', 'water bottle', 'floating bottle', 'river bottle',
  'water pollution', 'marine pollution', 'floating waste', 'river waste',
]

export const CANON = {
  'plastic bottle': { label: 'Plastic bottle', color: '#22D3EE' },
  trash: { label: 'Trash', color: '#3B9EFF' },
  'river trash': { label: 'River trash', color: '#00B8A9' }, // Teal for water
  human: { label: 'Human', color: '#FFD60A' },
}

/** raw label → 'plastic bottle' | 'trash' | 'river trash' | null (null = not shown). */
export function normalizeLabel(raw, context = { isWater: false }) {
  if (!raw) return null
  const s = String(raw).toLowerCase().trim()
  if (BOTTLE.some((k) => s.includes(k))) return 'plastic bottle'
  
  // Check for river trash terms first (more specific)
  if (context.isWater) {
    if (RIVER_TRASH.some((k) => s.includes(k)) || s === 'item') return 'river trash'
  }
  
  // Fall back to regular trash
  if (TRASH.some((k) => s.includes(k)) || s === 'item') return 'trash'
  
  return null
}

/** Keep only trash / plastic-bottle boxes, rewriting label + display colour. */
export function filterDetections(boxes, waterZones = []) {
  const out = []
  for (const b of boxes || []) {
    // Check if this detection is in a water zone
    const isInWater = waterZones.some(zone => {
      const boxCenterX = (b.x1 + b.x2) / 2
      const boxCenterY = (b.y1 + b.y2) / 2
      return boxCenterX >= zone.x1 && boxCenterX <= zone.x2 &&
             boxCenterY >= zone.y1 && boxCenterY <= zone.y2
    })
    
    const cls = normalizeLabel(b.label ?? b.class ?? b.name, { isWater: isInWater })
    if (!cls) continue
    out.push({ ...b, cls, label: CANON[cls].label, color: CANON[cls].color })
  }
  return out
}
