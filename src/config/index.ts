/**
 * 全局运行时配置
 *
 * 前端用到的配置与后端**同源**，都读仓库根目录的 config.env（见该文件里的逐项说明），
 * 由 vite.config.ts 在启动 / 构建时注入成 `__APP_CONFIG__` 常量。
 *
 * ⚠️ 两点必须知道：
 *   1. 这些值是**构建期常量**，改完 config.env 要重启 dev server 才生效，热更新不会重读文件。
 *   2. 只有 vite.config.ts 里 `appConfig` 白名单中的项才会进入浏览器代码。
 *      DeepSeek / 高德 的密钥只在后端用（server/src/config.ts），永远不要加进白名单。
 */

/** token 是否已配置 —— 供页面提示用 */
export const hasTiandituToken = (): boolean => TIANDITU_TOKEN.trim().length > 0

/** Cesium Ion World Terrain 与自定义地形服务的区分 */
export type TerrainProviderType = 'cesium' | 'arcgis'

/** 注入到前端的那部分配置 */
export interface AppConfig {
  /** 天地图开发者 token（底图瓦片，客户端直连，消耗天地图配额） */
  tiandituToken: string
  /** 是否启用真实高程地形，false 回退光滑椭球面 */
  terrainEnabled: boolean
  /** 自定义地形服务类型（仅当配了 terrainUrl 时生效） */
  terrainType: TerrainProviderType
  /** 自定义地形服务地址，优先级最高 */
  terrainUrl: string
  /** Cesium Ion 访问令牌（World Terrain 高程地形） */
  cesiumIonToken: string
}

/** 由 vite.config.ts 的 define 替换成字面量，运行时不存在这个变量 */
declare const __APP_CONFIG__: AppConfig

const appConfig: AppConfig = __APP_CONFIG__

/** 天地图开发者 token */
export const TIANDITU_TOKEN: string = appConfig.tiandituToken

/** Cesium Ion 访问令牌（可选，用于 World Terrain 高程地形 / Ion 影像） */
export const CESIUM_ION_TOKEN: string = appConfig.cesiumIonToken

/** 是否启用真实高程地形，置为 false 可关闭（回退为光滑椭球面） */
export const TERRAIN_ENABLED: boolean = appConfig.terrainEnabled

/** 自定义地形服务类型（仅当配置了 TERRAIN_URL 时生效） */
export const TERRAIN_TYPE: TerrainProviderType = appConfig.terrainType

/** 自定义地形服务地址（可选，优先级最高） */
export const TERRAIN_URL: string = appConfig.terrainUrl

/** 免 token 的公共高程地形服务（ArcGIS World Elevation 3D），作为默认地形源 */
export const ARCGIS_TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

/** 天地图服务子域名，用于绕过浏览器并发连接数限制 */
export const TIANDITU_SUBDOMAINS: string[] = ['0', '1', '2', '3', '4', '5', '6', '7']

/** 天地图标准 WMTS 最大层级 */
export const TIANDITU_MAX_LEVEL = 18

/** 默认初始视角：四川省全境（经纬高，米） */
export const HOME_VIEW = {
  longitude: 102.7,
  latitude: 30.6,
  height: 1_500_000,
} as const
