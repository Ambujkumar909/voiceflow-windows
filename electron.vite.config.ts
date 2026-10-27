import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
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
