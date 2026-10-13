/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/**
 * 注意：应用代码已不再直接读 `import.meta.env`，前端配置统一走根目录的
 * config.env（由 vite.config.ts 注入为 `__APP_CONFIG__`，见 src/config/index.ts）。
 * 下面这些 VITE_ 声明仅用于「config.env 里留空时」回退到根 .env 的旧用法。
 */
interface ImportMetaEnv {
  /** 天地图开发者 token */
  readonly VITE_TIANDITU_TOKEN: string
  /** Cesium Ion token（可选，用于加载 World Terrain 高程序列） */
  readonly VITE_CESIUM_ION_TOKEN?: string
  /** 是否启用真实高程地形，'false' 表示关闭 */
  readonly VITE_TERRAIN_ENABLED?: string
  /** 自定义地形服务类型：cesium | arcgis */
  readonly VITE_TERRAIN_TYPE?: string
  /** 自定义地形服务地址（可选） */
  readonly VITE_TERRAIN_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
