import { config } from '../config'

/**
 * 天地图地理编码（兜底方案）
 *
 * 注意：实测该服务精度不如高德，且存在假阳性 ——
 * 「理塘」会被解析到 120.416229,29.237112（浙江），score 仍是 99。
 * `mapBound` 参数经实测无效。因此本模块只作为高德失败后的兜底，
 * 且返回结果必须交由上层做 bbox 校验。
 *
 * 返回坐标为 CGCS2000/WGS84，无需转换。
 */

export interface TiandituPlace {
  name: string
  lng: number
  lat: number
  score: number
  level?: string
  provider: 'tianditu'
}

interface TiandituGeocoderResponse {
  msg: string
  status: string
  location?: {
    score: number
    level?: string
    lon: string
    lat: string
    keyWord?: string
  }
}

export async function geocodeByTianditu(keyword: string): Promise<TiandituPlace | null> {
  if (!config.tianditu.token) return null

  const ds = JSON.stringify({ keyWord: keyword })
  const url = `${config.tianditu.geocoderUrl}?ds=${encodeURIComponent(ds)}&tk=${config.tianditu.token}`

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) return null

    const text = await response.text()
    let data: TiandituGeocoderResponse
    try {
      data = JSON.parse(text) as TiandituGeocoderResponse
    } catch {
      return null
    }

    const location = data.location
    if (!location) return null

    const lng = Number(location.lon)
    const lat = Number(location.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null

    return {
      name: location.keyWord ?? keyword,
      lng,
      lat,
      score: location.score,
      level: location.level,
      provider: 'tianditu',
    }
  } catch {
    return null
  }
}
