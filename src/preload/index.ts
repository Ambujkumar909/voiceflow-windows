import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HistoryEntry, KeySlot, Stats, OverlayAction, OverlayCommand, OverlayState, PublicSettings, Settings, Status } from '../shared/types'

function on<T>(channel: string, fn: (v: T) => void): () => void {
  const h = (_e: IpcRendererEvent, v: T): void => fn(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

/** The only surface renderers get. No secrets cross this bridge (only which keys are set). */
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
    setApiKey: (slot: KeySlot, key: string): Promise<void> => ipcRenderer.invoke('settings:setApiKey', slot, key),
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
