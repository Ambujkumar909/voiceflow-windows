import type { Settings } from '../../shared/types'
import { getApiKey } from '../settings'
import { localWhisper } from './local-whisper'
import { openAiCompatible } from './openai'

/** Swap engines without touching the dictation flow. Audio is always 16 kHz mono float PCM. */
export interface SttProvider {
  id: string
  transcribe(pcm16k: Float32Array, language: string): Promise<string>
  warmup?(): Promise<void>
  status(): string
}

export function getProvider(s: Settings): SttProvider {
  // 'xai' streams during recording (see dictation.ts); this batch provider is its offline fallback.
  return s.provider === 'openai' ? openAiCompatible(s.apiBaseUrl, s.apiModel, () => getApiKey('openai')) : localWhisper(s.localModel)
}
