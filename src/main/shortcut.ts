import { globalShortcut } from 'electron'
import { log } from './log'

/*
 * Toggle-style hotkey via Electron globalShortcut (Win32 RegisterHotKey).
 * ponytail: RegisterHotKey only reports key-down, so hold-to-talk and modifier-only
 * hotkeys (e.g. Ctrl+Win, what the reference app uses) need a low-level keyboard
 * hook; add one (see README roadmap) if push-to-talk is required.
 */
let current = ''
let lastError = ''

export function registerToggle(accelerator: string, onPress: () => void): { ok: boolean; error: string } {
  const previous = current
  if (previous) globalShortcut.unregister(previous)
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, onPress)
    lastError = ok ? '' : `"${accelerator}" is already in use by another application or Windows.`
  } catch (e) {
    lastError = `"${accelerator}" is not a valid shortcut (${(e as Error).message}).`
  }
  if (ok) {
    current = accelerator
  } else {
    current = ''
    if (previous && globalShortcut.register(previous, onPress)) current = previous // keep the old one working
    log('warn', 'shortcut registration failed', { accelerator, error: lastError })
  }
  return { ok, error: lastError }
}

export const shortcutStatus = (): { registered: string; error: string } => ({ registered: current, error: lastError })

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  current = ''
}
