import { config } from '../config'
import type { PoiPhoto } from '../types'
import { createSerialQueue } from '../utils/async'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/coord'

/** 所有高德请求串行并限速，避免触发并发 QPS 限制 */
const enqueue = createSerialQueue(config.amap.minIntervalMs)

/** 高德并发超限错误码 */
const RATE_LIMIT_INFOCODE = '10021'

/**
 * 高德 Web 服务封装
 * 注意：高德所有接口的入参/出参坐标均为 GCJ-02，本模块统一在出口转成 WGS84，
 * 同时保留 GCJ-02 原值（后续调路径规划时要用）。
 */

export interface PlaceCandidate {
  name: string
  address?: string
  /** 省 */
  province?: string
  /** 市 */
  city?: string
  /** 区县 */
  district?: string
  /** WGS84 */
  lng: number
  lat: number
  /** GCJ-02 */
  lngGcj: number
  latGcj: number
  provider: 'amap'
  poiType?: string
  /** 实景图（高德 POI 图片，可能需要 extensions=all；结构化地理编码拿不到） */
  photos: PoiPhoto[]
}

interface AmapBaseResponse {
  status: string
  info: string
  infocode: string
}

interface AmapPoiItem {
  id: string
  name: string
  address?: string | string[]
  location: string
  pname?: string
  cityname?: string
  adname?: string
  type?: string
  /** extensions=all 时才返回 */
  photos?: { title?: string; url?: string }[]
}

interface AmapGeoItem {
  formatted_address?: string
  province?: string
  city?: string | string[]
  district?: string
  location: string
  level?: string
}

interface AmapDrivingStep {
  instruction?: string
  distance?: string
  duration?: string
  polyline?: string
}

interface AmapDrivingPath {
  distance: string
  duration: string
  steps: AmapDrivingStep[]
}

interface AmapDrivingResponse extends AmapBaseResponse {
  route?: {
    origin: string
    destination: string
    paths: AmapDrivingPath[]
  }
}

function toText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined
  return value
}

async function amapGetOnce<T extends AmapBaseResponse>(
  pathname: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(pathname, config.amap.baseUrl)
  url.searchParams.set('key', config.amap.key)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!response.ok) {
    throw new Error(`高德接口 HTTP ${response.status}`)
  }

  const data = (await response.json()) as T
  if (data.status !== '1') {
    throw new Error(`高德接口错误 ${data.infocode} ${data.info}`)
  }
  return data
}

/** 串行 + 限速 + 限流退避重试 */
async function amapGet<T extends AmapBaseResponse>(
  pathname: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  return enqueue(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await amapGetOnce<T>(pathname, params)
      } catch (error) {
        lastError = error
        const message = (error as Error).message
        // 仅对限流错误退避重试，其它错误（如 INVALID_USER_KEY）立即抛出
        if (!message.includes(RATE_LIMIT_INFOCODE)) throw error
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
    throw lastError
  })
}

/**
 * 归一化高德 POI 图片：只要 http(s) 的 URL，并统一升级成 https
 * （部分图片返回 http，页面在 https 下会被浏览器拦掉）。
 */
function normalizePhotos(raw: AmapPoiItem['photos']): PoiPhoto[] {
  const photos: PoiPhoto[] = []
  for (const item of raw ?? []) {
    // 高德的字段可能给成数组（和 address 一样），统一用 toText 取
    const url = toText(item.url as string | string[] | undefined)?.trim()
    if (!url || !/^https?:\/\//i.test(url)) continue
    photos.push({
      title: toText(item.title as string | string[] | undefined)?.trim() ?? '',
      url: url.replace(/^http:\/\//i, 'https://'),
    })
    if (photos.length >= 6) break
  }
  return photos
}

function buildCandidate(input: {
  name: string
  address?: string
  province?: string
  city?: string
  district?: string
  location: string
  poiType?: string
  photos?: AmapPoiItem['photos']
}): PlaceCandidate | null {
  const [lngGcj, latGcj] = input.location.split(',').map(Number)
  if (!Number.isFinite(lngGcj) || !Number.isFinite(latGcj)) return null

  const [lng, lat] = gcj02ToWgs84(lngGcj, latGcj)
  return {
    name: input.name,
    address: input.address,
    province: input.province,
    city: input.city,
    district: input.district,
    lng,
    lat,
    lngGcj,
    latGcj,
    provider: 'amap',
    poiType: input.poiType,
    photos: normalizePhotos(input.photos),
  }
}

/**
 * POI 关键字搜索：精度最高，用于景点落点。
 *
 * 用 extensions=all：同一个请求顺带把 POI 的实景图带回来，落点时就顺手存下，
 * 地图便签弹窗可以直接展示（`base` 不返回 photos）。
 */
export async function searchPoi(
  keyword: string,
  options: { city?: string; limit?: number } = {},
): Promise<PlaceCandidate[]> {
  const data = await amapGet<AmapBaseResponse & { pois?: AmapPoiItem[] }>('/v3/place/text', {
    keywords: keyword,
    city: options.city,
    citylimit: options.city ? 'true' : undefined,
    offset: options.limit ?? 5,
    page: 1,
    extensions: 'all',
  })

  return (data.pois ?? [])
    .map((item) =>
      buildCandidate({
        name: item.name,
        address: toText(item.address),
        province: item.pname,
        city: item.cityname,
        district: item.adname,
        location: item.location,
        poiType: item.type,
        photos: item.photos,
      }),
    )
    .filter((item): item is PlaceCandidate => item !== null)
}

/** 结构化地址地理编码，POI 搜索无结果时兜底 */
export async function geocodeAddress(
  address: string,
  city?: string,
): Promise<PlaceCandidate | null> {
  const data = await amapGet<AmapBaseResponse & { geocodes?: AmapGeoItem[] }>('/v3/geocode/geo', {
    address,
    city,
  })

  const item = data.geocodes?.[0]
  if (!item) return null

  return buildCandidate({
    name: item.formatted_address ?? address,
    address: item.formatted_address,
    province: item.province,
    city: toText(item.city),
    district: item.district,
    location: item.location,
  })
}

export interface DrivingResult {
  /** WGS84 折线点 [[lng,lat], ...] */
  path: [number, number][]
  distanceM: number
  durationS: number
  /** 路径文字指引，可用于手册 */
  steps: { instruction: string; distanceM: number; durationS: number }[]
}

/**
 * 驾车路径规划
 * 入参为 WGS84，内部转 GCJ-02 后请求高德，返回的折线再转回 WGS84。
 */
export async function planDriving(
  origin: [number, number],
  destination: [number, number],
  options: { strategy?: number } = {},
): Promise<DrivingResult> {
  const [oLng, oLat] = wgs84ToGcj02(origin[0], origin[1])
  const [dLng, dLat] = wgs84ToGcj02(destination[0], destination[1])

  const data = await amapGet<AmapDrivingResponse>('/v3/direction/driving', {
    origin: `${oLng.toFixed(6)},${oLat.toFixed(6)}`,
    destination: `${dLng.toFixed(6)},${dLat.toFixed(6)}`,
    strategy: options.strategy ?? 0,
    extensions: 'base',
  })

  const path0 = data.route?.paths?.[0]
  if (!path0) {
    throw new Error('高德未返回可用路径')
  }

  const path: [number, number][] = []
  const steps: DrivingResult['steps'] = []

  for (const step of path0.steps ?? []) {
    steps.push({
      instruction: step.instruction ?? '',
      distanceM: Number(step.distance ?? 0),
      durationS: Number(step.duration ?? 0),
    })

    for (const pair of (step.polyline ?? '').split(';')) {
      const [gLng, gLat] = pair.split(',').map(Number)
      if (!Number.isFinite(gLng) || !Number.isFinite(gLat)) continue
      const [wLng, wLat] = gcj02ToWgs84(gLng, gLat)
      const last = path[path.length - 1]
      // 去重，避免折线出现零长度段
      if (last && Math.abs(last[0] - wLng) < 1e-7 && Math.abs(last[1] - wLat) < 1e-7) continue
      path.push([wLng, wLat])
    }
  }

  return {
    path,
    distanceM: Number(path0.distance ?? 0),
    durationS: Number(path0.duration ?? 0),
    steps,
  }
}
