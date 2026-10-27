import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron'
import { join } from 'node:path'

// Transparent, click-through except for the pill. Tall enough for the tooltip, the live-caption
// card and error cards above the pill. The pill's bottom edge sits 14 px above the window's.
const OVERLAY_W = 512
const OVERLAY_H = 240
const TASKBAR_GAP = 2

const webPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
}

function load(win: BrowserWindow, page: 'overlay' | 'hub'): void {
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (dev) void win.loadURL(`${dev}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

/** Click-through, never-focused pill so the target app keeps keyboard focus. */
export function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true }) // forward moves so the page can see hovers
  positionOverlay(win)
  // Follow the mouse to whichever monitor it is on.
  let lastDisplay = 0
  const follow = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(follow)
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    if (d !== lastDisplay && win.isVisible()) positionOverlay(win)
    lastDisplay = d
  }, 400)
  win.once('ready-to-show', () => win.showInactive())
  load(win, 'overlay')
  return win
}

/** Bottom-center of the display under the mouse cursor. */
export function positionOverlay(win: BrowserWindow): void {
  const { workArea: a } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds({ x: Math.round(a.x + (a.width - OVERLAY_W) / 2), y: a.y + a.height - OVERLAY_H - TASKBAR_GAP, width: OVERLAY_W, height: OVERLAY_H })
  if (!win.isVisible()) win.showInactive()
}

// Hub colors follow the theme: window background = sidebar/title bar sand, symbols = text color.
const hubColors = (): { bg: string; fg: string } => (nativeTheme.shouldUseDarkColors ? { bg: '#0b0b10', fg: '#ececf3' } : { bg: '#f4f4f7', fg: '#101018' })
export const TITLEBAR_H = 44

let hubWin: BrowserWindow | null = null
/** Main window: frameless with native Windows caption buttons drawn over a 44 px custom title bar. */
export function showHub(): BrowserWindow {
  if (hubWin && !hubWin.isDestroyed()) {
    if (hubWin.isMinimized()) hubWin.restore()
    hubWin.show()
    hubWin.focus()
    return hubWin
  }
  const c = hubColors()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'VoiceFlow',
    icon: appIcon(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: TITLEBAR_H },
    backgroundColor: c.bg,
    show: false,
    webPreferences
  })
  const recolor = (): void => {
    const k = hubColors()
    win.setTitleBarOverlay({ color: k.bg, symbolColor: k.fg })
    win.setBackgroundColor(k.bg)
  }
  nativeTheme.on('updated', recolor)
  win.on('closed', () => nativeTheme.off('updated', recolor))
  win.once('ready-to-show', () => win.show())
  load(win, 'hub')
  hubWin = win
  return win
}

/** Tell the hub to refetch (new dictation, settings changed elsewhere). */
export const notifyHub = (): void => void (hubWin && !hubWin.isDestroyed() && hubWin.webContents.send('hub:changed'))

// Icons are rendered from build/icon.svg by `npm run icons` (tray.png has a tray@2x.png twin for high DPI).
const asset = (name: string): string => join(app.getAppPath(), 'resources', name)
const appIcon = (): Electron.NativeImage => nativeImage.createFromPath(asset('icon.png'))
const trayImages = { idle: 'tray.png', rec: 'tray-rec.png' }

let tray: Tray | null = null
export function createTray(actions: { toggle: () => void; settings: () => void; quit: () => void }): Tray {
  tray = new Tray(nativeImage.createFromPath(asset(trayImages.idle)))
  tray.setToolTip('VoiceFlow — idle')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Start / stop dictation', click: actions.toggle },
      { label: 'Open VoiceFlow', click: actions.settings },
      { type: 'separator' },
      { label: 'Quit VoiceFlow', click: actions.quit }
    ])
  )
  tray.on('click', actions.settings)
  return tray
}

export function setTrayStatus(text: string): void {
  tray?.setToolTip('VoiceFlow — ' + text)
  tray?.setImage(nativeImage.createFromPath(asset(text === 'recording' ? trayImages.rec : trayImages.idle)))
}
