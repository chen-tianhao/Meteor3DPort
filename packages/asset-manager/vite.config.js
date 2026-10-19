import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
//
// 同 scene-editor：受限环境下可用 METEOR3D_VITE_CACHE_DIR 把依赖预构建缓存
// 挪出 node_modules，规避 esbuild 写入被拒的问题。
const cacheDir = process.env.METEOR3D_VITE_CACHE_DIR || undefined

export default defineConfig({
    plugins: [
        vue(),
        vueDevTools(),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url))
        }
    },
    server: {
        port: 5175
    },
    ...(cacheDir ? { cacheDir } : {}),
})
