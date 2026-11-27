// Renders the app icon from build/icon.svg (and build/icon-small.svg for the
// tiny sizes) into everything that uses it:
//   build/icon.png   1024 px — electron-builder and the window icon
//   build/icon.ico   16–256 px — Windows exe, installer and shortcuts
//   public/favicon.png  64 px — the page icon
// Run with `npm run icons` after changing either SVG.

import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const big = readFileSync('build/icon.svg', 'utf8')
const small = readFileSync('build/icon-small.svg', 'utf8')

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

// An .ico whose images are stored as PNGs (supported since Windows Vista).
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e)
    head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt8(0, e + 2)
    head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(png.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map((im) => im.png)])
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const images = sizes.map((size) => ({ size, png: render(size <= 32 ? small : big, size) }))

writeFileSync('build/icon.png', render(big, 1024))
writeFileSync('build/icon.ico', ico(images))
writeFileSync('public/favicon.png', render(small, 64))
console.log(`icons: build/icon.png (1024), build/icon.ico (${sizes.join(', ')}), public/favicon.png (64)`)
