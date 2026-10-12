import * as Cesium from 'cesium'
import { TIANDITU_MAX_LEVEL, TIANDITU_SUBDOMAINS, TIANDITU_TOKEN } from '@/config'

const TIANDITU_HOST = 'https://t{s}.tianditu.gov.cn'

/**
 * 天地图图层类型：
 * - vec 矢量底图   cva 矢量注记
 * - img 影像底图   cia 影像注记
 * - ter 地形晕渲   ibo 全球境界   cta 中文注记（部分服务）
 */
export type TiandituLayerType = 'vec' | 'cva' | 'img' | 'cia' | 'ter' | 'ibo' | 'cta'

/**
 * 瓦片矩阵集：
 * - w：Web 墨卡托投影（EPSG:3857），Cesium 默认椭球贴图坐标，推荐
 * - c：经纬度直投（CGCS2000 / EPSG:4326）
 */
export type TiandituMatrixSet = 'w' | 'c'

export interface TiandituLayerOptions {
  /** 图层类型 */
  type: TiandituLayerType
  /** 瓦片矩阵集，默认 w（Web 墨卡托） */
  matrixSet?: TiandituMatrixSet
  /** 最大层级，默认 18 */
  maximumLevel?: number
  /** 最小层级 */
  minimumLevel?: number
  /** 图层不透明度 0~1 */
  alpha?: number
  /** 图层亮度，>1 提亮，<1 压暗 */
  brightness?: number
}

/** 拼接天地图 WMTS GetTile 地址模板 */
export function buildTiandituUrl(type: TiandituLayerType, matrixSet: TiandituMatrixSet = 'w'): string {
  const service = `${type}_${matrixSet}`
  const query = [
    'SERVICE=WMTS',
    'REQUEST=GetTile',
    'VERSION=1.0.0',
    `LAYER=${type}`,
    'STYLE=default',
    `TILEMATRIXSET=${matrixSet}`,
    'FORMAT=tiles',
    'TILEMATRIX={TileMatrix}',
    'TILEROW={TileRow}',
    'TILECOL={TileCol}',
    `tk=${TIANDITU_TOKEN}`,
  ].join('&')
  return `${TIANDITU_HOST}/${service}/wmts?${query}`
}

/** 创建天地图 WMTS 影像 Provider */
export function createTiandituProvider(options: TiandituLayerOptions): Cesium.WebMapTileServiceImageryProvider {
  const {
    type,
    matrixSet = 'w',
    maximumLevel = TIANDITU_MAX_LEVEL,
    minimumLevel = 1,
  } = options

  return new Cesium.WebMapTileServiceImageryProvider({
    url: buildTiandituUrl(type, matrixSet),
    layer: type,
    style: 'default',
    format: 'tiles',
    tileMatrixSetID: matrixSet,
    subdomains: TIANDITU_SUBDOMAINS,
    minimumLevel,
    maximumLevel,
    credit: new Cesium.Credit('天地图 · GS(2023)336号', false),
  })
}

/** 创建天地图影像图层（ImageryLayer），并应用透明度/亮度 */
export function createTiandituLayer(options: TiandituLayerOptions): Cesium.ImageryLayer {
  const layer = new Cesium.ImageryLayer(createTiandituProvider(options))
  if (typeof options.alpha === 'number') layer.alpha = options.alpha
  if (typeof options.brightness === 'number') layer.brightness = options.brightness
  return layer
}

/**
 * 预校验 token 是否可用（天地图返回 403/401 或 XML 错误时判定失效）。
 * 说明：天地图 token 通常绑定域名白名单，本地开发需在控制台把 localhost/127.0.0.1 加入白名单。
 */
export async function validateTiandituToken(): Promise<boolean> {
  if (!TIANDITU_TOKEN) return false
  const url = buildTiandituUrl('vec', 'w')
    .replace('{s}', '0')
    .replace('{TileMatrix}', '1')
    .replace('{TileRow}', '0')
    .replace('{TileCol}', '0')
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') ?? ''
    // 正常返回图片；token 失效时天地图返回 XML 文本
    return contentType.startsWith('image/')
  } catch {
    return false
  }
}
