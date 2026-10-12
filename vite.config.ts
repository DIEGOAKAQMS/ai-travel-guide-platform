import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

/** Cesium 静态资源（Worker / 贴图 / 第三方库）源码目录 */
const cesiumSource = 'node_modules/cesium/Build/Cesium'
/** Cesium 静态资源在产物中的输出目录（必须与 CESIUM_BASE_URL 保持一致） */
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  plugins: [
    vue(),
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
      ],
    }),
  ],
  define: {
    // Cesium 运行时依赖该全局变量定位 Workers/Assets 等资源
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5188,
    host: true,
    open: true,
    // 前端 /api 转发到后端服务，避免跨域配置
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5300',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Cesium 体积较大，单独拆包以提升首屏加载与缓存命中率
        manualChunks: {
          cesium: ['cesium'],
          vendor: ['vue', 'pinia'],
        },
      },
    },
  },
})
