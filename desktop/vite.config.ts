import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
})
