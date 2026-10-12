/** ============ LLM 输出的原始结构 ============ */

/** 行程节点类型 */
export type NodeKind = 'spot' | 'view' | 'town' | 'meal' | 'drive' | 'rest'
/** 节点重要度 */
export type NodePriority = 'key' | 'normal' | 'optional'

/** 点位实景图（来源高德 POI 图片） */
export interface PoiPhoto {
  title: string
  url: string
}

export interface LlmNode {
  /** 建议时间 'HH:mm' */
  time?: string
  /** 节点名称 */
  name: string
  /** 节点类型，默认 spot */
  kind?: NodeKind
  /** 所属行政区划；仅可检索的真实地点才给，赶路/休整类留空 */
  city?: string
  /** 建议停留分钟数 */
  stay_minutes?: number
  /** 重要度 */
  priority?: NodePriority
  /** 玩法描述（时间轴展示） */
  desc?: string
  /** 避坑提醒（时间轴展示） */
  warnings?: string
  /** 实用建议（时间轴展示） */
  tips?: string
  /** 弹窗详细介绍：与 desc / warnings / tips 分工，不复述时间轴内容 */
  detail?: string
  /** 弹窗看点短句 */
  highlights?: string[]
  /** 最佳时段 / 季节 */
  best_time?: string
  /** 配图检索关键词（系统据此找实景图） */
  photo_keywords?: string[]
  /** 距上一节点的里程（km） */
  leg_km?: number
}

export interface LlmDay {
  day_index: number
  title?: string
  summary?: string
  /** 路线串联：成都 → 都江堰 → 四姑娘山镇 */
  route?: string
  /** 住宿地 */
  stay?: string
  /** 当日看点 */
  highlights?: string
  /** 当日注意事项 / 纪律 */
  cautions?: string
  /** 当日自驾里程（km） */
  drive_km?: number
  /** 车程文案，如 '4–5 h' */
  drive_hours?: string
  /** 住宿海拔（米） */
  sleep_altitude_m?: number
  /** 当日最高海拔（米） */
  max_altitude_m?: number
  /** 当日提示文案 */
  notes?: string[]
  /** 时间轴节点，按游玩顺序 */
  timeline: LlmNode[]
}

export interface LlmGuide {
  title: string
  region?: string
  summary?: string
  total_days?: number
  days: LlmDay[]
}

/** ============ 落点结果 ============ */

/**
 * ok      —— 落在目标区域内，可用
 * suspect —— 解析到区域外，大概率是假阳性，需人工确认
 * failed  —— 完全没解析到坐标
 * manual  —— 人工指定
 * skipped —— 该节点类型无需落点（赶路 / 休整）
 */
export type GeocodeStatus = 'ok' | 'suspect' | 'failed' | 'manual' | 'skipped'

export interface ResolvedNode {
  day_index: number
  seq: number
  time?: string
  name: string
  kind: NodeKind
  priority: NodePriority
  city?: string
  address?: string
  desc?: string
  warnings?: string
  tips?: string
  /** 弹窗详情：与时间轴内容分工 */
  detail?: string
  highlights?: string[]
  best_time?: string
  photo_keywords?: string[]
  /** 实景图：落点时从高德 POI 结果里带回来，可能为空 */
  photos?: PoiPhoto[]
  leg_km?: number
  stay_minutes?: number
  lng?: number
  lat?: number
  lng_gcj?: number
  lat_gcj?: number
  geocode_status: GeocodeStatus
  geocode_score?: number
  geocode_provider?: string
  geocode_keyword?: string
}

export interface Bbox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

/** ============ 接口返回 ============ */

export interface GuidePoiDto {
  id: string
  day_id: string | null
  seq: number
  arrive_time: string | null
  name: string
  kind: NodeKind
  priority: NodePriority
  city: string | null
  address: string | null
  lng: number | null
  lat: number | null
  stay_minutes: number | null
  notes: string | null
  warnings: string | null
  tips: string | null
  leg_km: number | null
  /** 弹窗详情：与时间轴内容分工，不在时间轴上展示 */
  detail: string | null
  highlights: string[]
  best_time: string | null
  photo_keywords: string[]
  photos: PoiPhoto[]
  geocode_status: GeocodeStatus
  geocode_provider: string | null
  verified: boolean
}

export interface GuideDayDto {
  id: string
  day_index: number
  title: string | null
  summary: string | null
  route_text: string | null
  stay_text: string | null
  highlights: string | null
  cautions: string | null
  drive_km: number | null
  drive_hours: string | null
  drive_minutes: number | null
  sleep_altitude_m: number | null
  max_altitude_m: number | null
  notes: string[]
  pois: GuidePoiDto[]
}

export interface GuideRouteDto {
  id: string
  day_id: string | null
  from_poi_id: string | null
  to_poi_id: string | null
  seq: number
  /** true = 跨天转移路段（上一日终点 → 次日起点） */
  transfer: boolean
  /** WGS84 折线 [[lng, lat], ...] */
  path: [number, number][]
  distance_m: number | null
  duration_s: number | null
  from_name: string | null
  to_name: string | null
}

export interface GuideDto {
  id: string
  title: string
  region: string | null
  prompt: string | null
  summary: string | null
  total_days: number
  status: string
  created_at: string
  /** 软删除（归档）时间；非空表示已归档 */
  archived_at: string | null
  days: GuideDayDto[]
  routes: GuideRouteDto[]
}

export interface GenerateIssue {
  poi: string
  day_index: number
  reason: string
  status: GeocodeStatus
  keyword?: string
  resolved?: { lng: number; lat: number }
}
