import { uIOhook, UiohookKey as K, type UiohookKeyboardEvent } from 'uiohook-napi'
import type { HoldKeys } from '../shared/types'
import { pressChord } from './insert'
import { log } from './log'

/*
 * Hold-to-talk through a low-level keyboard hook (uiohook-napi). The hook only listens;
 * it never blocks or changes keys. Hold the combo to record and release it to transcribe.
 * Pressing any other non-modifier key while holding aborts, so shortcuts that start
 * with the same modifiers (Ctrl+Win+D, Ctrl+Alt+T…) keep working.
 */
const COMBOS: Record<Exclude<HoldKeys, 'off'>, number[][]> = {
  'Ctrl+Win': [[K.Ctrl, K.CtrlRight], [K.Meta, K.MetaRight]],
  'Ctrl+Alt': [[K.Ctrl, K.CtrlRight], [K.Alt, K.AltRight]],
  'Right Alt': [[K.AltRight]],
  'Right Ctrl': [[K.CtrlRight]]
}
const MODS = { ctrlKey: [K.Ctrl, K.CtrlRight], altKey: [K.Alt, K.AltRight], shiftKey: [K.Shift, K.ShiftRight], metaKey: [K.Meta, K.MetaRight] } as const
const IS_MOD = new Set<number>(Object.values(MODS).flat())
// Unassigned virtual key. Injecting it while Win/Alt is held stops their release from
// opening the Start menu or an app's menu bar.
const MASK_VK = 0xe8

export interface HoldHandlers {
  /** First key of the combo went down: warm things up, a press may follow. */
  prime(): void
  press(): void
  release(aborted: boolean): void
}

let combo: number[][] = []
let handlers: HoldHandlers
let running = false
let holding = false
let aborted = false
const down = new Set<number>()

const comboDown = (): boolean => combo.length > 0 && combo.every((g) => g.some((k) => down.has(k)))

/** The modifier flags on every event are the source of truth; this heals keys whose key-up we missed (e.g. Win+L). */
function syncMods(e: UiohookKeyboardEvent): void {
  for (const [flag, keys] of Object.entries(MODS)) if (!e[flag as keyof typeof MODS]) keys.forEach((k) => k !== e.keycode && down.delete(k))
}

function onDown(e: UiohookKeyboardEvent): void {
  if (!e.keycode) return // our own mask key and other unmapped keys
  syncMods(e)
  if (down.has(e.keycode)) return // auto-repeat
  down.add(e.keycode)
  if (holding) {
    if (!IS_MOD.has(e.keycode) && !aborted) {
      aborted = true
      log('info', 'hold aborted by another key', { keycode: e.keycode })
      handlers.release(true)
    }
  } else if (IS_MOD.has(e.keycode) && !comboDown() && combo.some((g) => g.includes(e.keycode))) {
    handlers.prime()
  } else if (IS_MOD.has(e.keycode) && comboDown()) {
    holding = true
    aborted = false
    if (combo.flat().some((k) => k === K.Meta || k === K.MetaRight || k === K.Alt || k === K.AltRight)) void pressChord([MASK_VK]).catch(() => {})
    handlers.press()
  }
}

function onUp(e: UiohookKeyboardEvent): void {
  down.delete(e.keycode)
  syncMods(e)
  if (holding && !comboDown()) {
    holding = false
    if (!aborted) handlers.release(false)
  }
}

export function initHoldHook(h: HoldHandlers): void {
  handlers = h
  uIOhook.on('keydown', onDown)
  uIOhook.on('keyup', onUp)
}

/** Start, change or stop the hook. The hook only runs while a hold combo is configured. */
export function setHoldKeys(keys: HoldKeys): { ok: boolean; error: string } {
  combo = keys === 'off' ? [] : COMBOS[keys]
  holding = false
  down.clear()
  try {
    if (combo.length && !running) uIOhook.start()
    if (!combo.length && running) uIOhook.stop()
    running = combo.length > 0
    return { ok: true, error: '' }
  } catch (e) {
    log('error', 'keyboard hook failed', { error: String(e) })
    return { ok: false, error: `Hold-to-talk unavailable: ${(e as Error).message}` }
  }
}

export function stopHoldHook(): void {
  if (running) uIOhook.stop()
  running = false
}
