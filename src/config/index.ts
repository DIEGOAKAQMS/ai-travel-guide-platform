/**
 * 全局运行时配置
 * 统一从环境变量读取，避免 token 硬编码散落在业务代码中。
 */

/** 天地图开发者 token */
export const TIANDITU_TOKEN: string = import.meta.env.VITE_TIANDITU_TOKEN ?? ''

/** Cesium Ion 访问令牌（可选，用于 World Terrain 高程地形 / Ion 影像） */
export const CESIUM_ION_TOKEN: string = import.meta.env.VITE_CESIUM_ION_TOKEN ?? ''

/** 是否启用真实高程地形，置为 false 可关闭（回退为光滑椭球面） */
export const TERRAIN_ENABLED: boolean = (import.meta.env.VITE_TERRAIN_ENABLED ?? 'true') !== 'false'

/** 自定义地形服务类型：cesium = quantized-mesh（layer.json），arcgis = ArcGIS ImageServer */
export type TerrainProviderType = 'cesium' | 'arcgis'

/** 自定义地形服务类型（仅当配置了 TERRAIN_URL 时生效） */
export const TERRAIN_TYPE: TerrainProviderType = (import.meta.env.VITE_TERRAIN_TYPE ??
  'cesium') as TerrainProviderType

/** 自定义地形服务地址（可选，优先级最高） */
export const TERRAIN_URL: string = import.meta.env.VITE_TERRAIN_URL ?? ''

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

/** token 是否已配置 */
export const hasTiandituToken = (): boolean => TIANDITU_TOKEN.trim().length > 0
