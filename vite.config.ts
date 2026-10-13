import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

/** 项目根目录（本配置文件所在目录） */
const rootDir = dirname(fileURLToPath(import.meta.url))

/** Cesium 静态资源（Worker / 贴图 / 第三方库）源码目录 */
const cesiumSource = 'node_modules/cesium/Build/Cesium'
/** Cesium 静态资源在产物中的输出目录（必须与 CESIUM_BASE_URL 保持一致） */
const cesiumBaseUrl = 'cesiumStatic'

/**
 * 解析 KEY=VALUE 形式的配置文件。
 *
 * 与后端用的 dotenv 对齐三点：忽略空行与 `#` 注释、`=` 之后取到行尾、
 * 成对引号剥掉。config.env 里只会有最简单的键值对，故不支持多行与转义。
 * 空值直接跳过 —— 与后端一致，空值视为「未设置」，交给下层兜底。
 */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const parsed: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    if (value) parsed[key] = value
  }
  return parsed
}

export default defineConfig(({ mode }) => {
  /**
   * 前端配置与后端同源，都读仓库根目录的 config.env；
   * 某一项在这里留空时，回退到 Vite 原生的 .env（含 .env.local / .env.[mode]）。
   *
   * 注意：这是**启动 / 构建时**的一次性快照，改完 config.env 必须重启 dev server，
   * 热更新不会重读文件。
   */
  const appEnv = parseEnvFile(resolve(rootDir, 'config.env'))
  const dotEnv = loadEnv(mode, rootDir, 'VITE_')
  const pick = (key: string): string => appEnv[key] ?? dotEnv[key] ?? ''

  /**
   * 注入到浏览器端的配置白名单。
   *
   * ⚠️ 只有这里列出的项才会进入前端产物 —— DeepSeek / 高德 的密钥
   * 绝不能加进来（它们只在后端用，见 server/src/config.ts）。
   */
  const appConfig = {
    tiandituToken: pick('VITE_TIANDITU_TOKEN'),
    terrainEnabled: pick('VITE_TERRAIN_ENABLED') !== 'false',
    terrainType: pick('VITE_TERRAIN_TYPE') || 'cesium',
    terrainUrl: pick('VITE_TERRAIN_URL'),
    cesiumIonToken: pick('VITE_CESIUM_ION_TOKEN'),
  }

  return {
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
      // 前端配置（见 src/config/index.ts 的 __APP_CONFIG__）
      __APP_CONFIG__: JSON.stringify(appConfig),
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
          // Cesium 体积较大，单独拆包以提升首屏加载与缓存命中
          manualChunks: {
            cesium: ['cesium'],
            vendor: ['vue', 'pinia'],
          },
        },
      },
    },
  }
})
