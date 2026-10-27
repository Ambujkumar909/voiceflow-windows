// Renders build/icon.svg into every icon the app and installer need: `npm run icons`.
// Electron draws the SVG offscreen at each exact pixel size; the .ico is assembled here
// (PNG-compressed entries, supported since Windows Vista), so no image tools are needed.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')
// ≤24 px: three thicker bars so the V stays crisp (five bars blur together at tray size).
const small = svg
  .replace(/<g fill="#f5f4f0">[\s\S]*?<\/g>/, '<g fill="#f5f4f0"><rect x="196" y="236" width="160" height="552" rx="80" /><rect x="668" y="236" width="160" height="552" rx="80" /></g>')
  .replace('<rect x="476" y="494" width="88" height="276" rx="44"', '<rect x="432" y="476" width="160" height="312" rx="80"')
const forSize = (s) => (s <= 24 ? small : svg)
// Recording variant for the tray: the accent bar turns red.
const red = (m) => m.replace('#ffbf6b', '#ff7a86').replace('#ff9a2e', '#ff4d5e')

let win
async function render(markup, size) {
  if (!win) {
    win = new BrowserWindow({ width: 640, height: 640, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
    await win.loadURL('about:blank')
  }
  const sized = markup.replace('<svg ', `<svg width="${size}" height="${size}" `)
  await win.webContents.executeJavaScript(`document.body.style.cssText='margin:0;background:transparent';document.body.innerHTML=${JSON.stringify(sized)};new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
  await new Promise((r) => setTimeout(r, 120))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // icon
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e)
    head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bpp
    head.writeUInt32LE(png.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...pngs.map(([, p]) => p)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const pngs = []
  for (const s of sizes) pngs.push([s, await render(forSize(s), s)])
  writeFileSync(join(root, 'build', 'icon.ico'), ico(pngs))
  writeFileSync(join(root, 'build', 'icon.png'), await render(svg, 512))
  writeFileSync(join(root, 'resources', 'icon.png'), await render(svg, 256)) // window/taskbar icon
  // Tray: 16 px + @2x for high-DPI screens, normal and recording.
  writeFileSync(join(root, 'resources', 'tray.png'), await render(small, 16))
  writeFileSync(join(root, 'resources', 'tray@2x.png'), await render(svg, 32))
  writeFileSync(join(root, 'resources', 'tray-rec.png'), await render(red(small), 16))
  writeFileSync(join(root, 'resources', 'tray-rec@2x.png'), await render(red(svg), 32))
  console.log('icons written:', sizes.join(', '), '+ 512 png, tray (normal/recording)')
  app.exit(0)
})
