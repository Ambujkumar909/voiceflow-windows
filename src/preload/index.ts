import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HistoryEntry, Stats, OverlayAction, OverlayCommand, OverlayState, PublicSettings, Settings, Status } from '../shared/types'

function on<T>(channel: string, fn: (v: T) => void): () => void {
  const h = (_e: IpcRendererEvent, v: T): void => fn(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

type Result<T = unknown> = { ok: boolean; error: string; data?: T }
export type Device = { id: string; device: string; createdAt: string; lastUsedAt: string; current: boolean }

/** The only surface renderers get. No secrets cross this bridge (only whether a session exists). */
const api = {
  overlay: {
    onState: (fn: (s: OverlayState) => void) => on('overlay:state', fn),
    onCommand: (fn: (c: OverlayCommand) => void) => on('overlay:cmd', fn),
    sendAudio: (pcm: Float32Array): Promise<void> => ipcRenderer.invoke('overlay:audio', pcm),
    sendChunk: (pcm: Float32Array): void => ipcRenderer.send('overlay:chunk', pcm),
    setInteractive: (on: boolean): void => ipcRenderer.send('overlay:interactive', on),
    action: (a: OverlayAction): void => ipcRenderer.send('overlay:action', a),
    hint: (): Promise<string> => ipcRenderer.invoke('overlay:hint'),
    sendError: (msg: string): Promise<void> => ipcRenderer.invoke('overlay:error', msg)
  },
  settings: {
    get: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<Settings>): Promise<{ settings: PublicSettings; error: string }> => ipcRenderer.invoke('settings:save', patch),
    signIn: (email: string, password: string): Promise<Result> => ipcRenderer.invoke('account:signIn', email, password),
    signUp: (email: string, password: string): Promise<Result> => ipcRenderer.invoke('account:signUp', email, password),
    devices: (): Promise<Result<Device[]>> => ipcRenderer.invoke('account:devices'),
    signOutDevice: (id: string): Promise<Result> => ipcRenderer.invoke('account:signOutDevice', id),
    signOutEverywhere: (): Promise<Result> => ipcRenderer.invoke('account:signOutEverywhere'),
    changePassword: (current: string, next: string): Promise<Result> => ipcRenderer.invoke('account:changePassword', current, next),
    deleteAccount: (password: string): Promise<Result> => ipcRenderer.invoke('account:delete', password),
    signOut: (): Promise<void> => ipcRenderer.invoke('account:signOut'),
    status: (): Promise<Status> => ipcRenderer.invoke('status:get'),
    history: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:get'),
    clearHistory: (): Promise<void> => ipcRenderer.invoke('history:clear'),
    deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke('history:delete', id),
    stats: (): Promise<Stats> => ipcRenderer.invoke('stats:get'),
    info: (): Promise<{ version: string }> => ipcRenderer.invoke('app:info'),
    onChanged: (fn: () => void) => on('hub:changed', fn)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
