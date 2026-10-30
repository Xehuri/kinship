import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// 从项目根目录的 config.yaml 读取百度地图 API Key
function loadBaiduMapAk(): string {
  try {
    const configPath = path.resolve(__dirname, '../../config.yaml')
    const raw = fs.readFileSync(configPath, 'utf-8')
    // 用正则从 YAML 中提取 baidu_map_ak 值
    const match = raw.match(/baidu_map_ak:\s*['"]?([^\s'"]+)['"]?/)
    return match?.[1] || ''
  } catch {
    console.warn('[vite] 无法读取 config.yaml 中的 baidu_map_ak')
    return ''
  }
}

const baiduMapAk = loadBaiduMapAk()

export default defineConfig({
  plugins: [vue()],
  base: '/mobile/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 开发服务器: 本地调试用, proxy 转发到后端 HTTPS 8768 (原 refactor 沙箱能力并入 mobile)
  // 访问路径与生产一致: http://localhost:5173/mobile/
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['example.com'],
    proxy: {
      '/api': {
        target: 'https://127.0.0.1:8768',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'wss://127.0.0.1:8768',
        ws: true,
      },
      '/auth': {
        target: 'https://127.0.0.1:8768',
        changeOrigin: true,
        secure: false,
      },
      '/login': {
        target: 'https://127.0.0.1:8768',
        changeOrigin: true,
        secure: false,
      },
      '/logout': {
        target: 'https://127.0.0.1:8768',
        changeOrigin: true,
        secure: false,
      },
      '/health': {
        target: 'https://127.0.0.1:8768',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    target: 'es2015',
    outDir: 'dist',
  },
  define: {
    // 构建/开发时注入百度地图 AK，不依赖 .env 文件
    'import.meta.env.VITE_BAIDU_MAP_AK': JSON.stringify(baiduMapAk),
  },
})
