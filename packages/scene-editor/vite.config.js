import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
//
// 依赖预构建缓存默认写到 <项目>/node_modules/.vite。某些受限环境（容器、
// 杀毒软件锁定 node_modules、只读依赖目录）下 esbuild 无法在该位置写入，
// 表现为 "Failed to write to output file ... Access is denied"。
// 设置环境变量 METEOR3D_VITE_CACHE_DIR 即可把缓存挪到可写目录：
//   Windows (PowerShell): $env:METEOR3D_VITE_CACHE_DIR="$PWD\.vite-cache"; pnpm dev:scene
//   macOS / Linux:        METEOR3D_VITE_CACHE_DIR=$PWD/.vite-cache pnpm dev:scene
const cacheDir = process.env.METEOR3D_VITE_CACHE_DIR || undefined

export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  optimizeDeps: {
    include: ['@sparkjsdev/spark'],
  },
  ...(cacheDir ? { cacheDir } : {}),
})
