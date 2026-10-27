import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Dev-only benchmark tooling loads Whisper on demand; never bundle it (and it isn't shipped).
  main: { build: { rollupOptions: { external: ['@huggingface/transformers'] } } },
  preload: {},
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          hub: resolve(__dirname, 'src/renderer/hub/index.html')
        }
      }
    }
  }
})
