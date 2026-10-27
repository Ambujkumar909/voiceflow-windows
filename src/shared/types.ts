export const HOLD_KEYS = ['Ctrl+Win', 'Ctrl+Alt', 'Right Alt', 'Right Ctrl', 'off'] as const
export type HoldKeys = (typeof HOLD_KEYS)[number]

export type DictationState = 'idle' | 'recording' | 'processing' | 'success' | 'error'

export interface OverlayState {
  state: DictationState
  message?: string
  /** Live words while streaming. */
  live?: string
  /** Recording that ends on a press (not on release): shows cancel/finish buttons. */
  handsFree?: boolean
  /** The hotkey as shown in tooltips, e.g. "Ctrl + Win". */
  hint?: string
  sounds?: boolean
}

export type OverlayAction = 'start' | 'stop' | 'cancel' | 'menu'

/** What the browser audio stack may do to the mic signal before we get it. */
export type AudioProcessing = 'raw' | 'gain' | 'denoise'

export type OverlayCommand =
  | { cmd: 'start'; deviceId: string; stream: boolean; processing: AudioProcessing }
  | { cmd: 'stop' }
  | { cmd: 'cancel' }
  | { cmd: 'arm'; deviceId: string; processing: AudioProcessing }
  | { cmd: 'disarm' }

/** Secrets kept encrypted on this PC (Windows DPAPI). Only the VoiceFlow session's refresh token. */
export type KeySlot = 'session'

export interface CleanupOptions {
  removeFillers: boolean
  capitalize: boolean
  finalPunctuation: boolean
  spokenCommands: boolean
  trailingSpace: boolean
}

export interface Settings {
  shortcut: string
  holdKeys: HoldKeys
  micDeviceId: string
  /** Keep the mic open with a 0.5 s in-memory pre-roll so the first word is never clipped. */
  instantMic: boolean
  audioProcessing: AudioProcessing
  /** VoiceFlow server (https; http only for localhost during development). */
  serverUrl: string
  /** Signed-in account, for display. The session itself is the encrypted refresh token. */
  accountEmail: string
  /** Words to recognize (sent to the engine as keyterms) and misspellings to fix. Synced to the server. */
  dictionary: DictEntry[]
  /** Server-side AI cleanup (self-corrections, punctuation); never rewrites words. */
  polish: boolean
  language: string
  insertMode: 'paste' | 'type'
  restoreClipboard: boolean
  cleanup: CleanupOptions
  openAtLogin: boolean
  saveHistory: boolean
  sounds: boolean
  /** First name shown in the hub greeting. */
  name: string
  theme: 'system' | 'light' | 'dark'
}

/** What the renderer sees: settings minus secrets. */
export interface PublicSettings extends Settings {
  signedIn: boolean
}

export interface DictEntry {
  /** The correct spelling; also biases recognition. */
  word: string
  /** Optional wrong spelling that is replaced by `word` in transcripts. */
  misspelling?: string
}

export interface Stats {
  totalWords: number
  wpm: number
  streakDays: number
}

export interface HistoryEntry {
  id: string
  at: number
  text: string
  raw: string
  durationMs: number
  app: string
  provider: string
}

export interface Status {
  shortcutRegistered: boolean
  shortcutError: string
  holdError: string
  micAccess: string
  /** Connection to the VoiceFlow server, e.g. "connected". */
  engine: string
  accountError: string
  logPath: string
  encryptionAvailable: boolean
}
