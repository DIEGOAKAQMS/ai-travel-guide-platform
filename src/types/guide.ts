/** 与后端 server/src/types.ts 保持一致的 DTO 定义 */

/** 行程节点类型 */
export type NodeKind = 'spot' | 'view' | 'town' | 'meal' | 'drive' | 'rest'
/** 节点重要度 */
export type NodePriority = 'key' | 'normal' | 'optional'

/**
 * ok      —— 落在目标区域内，可用
 * suspect —— 解析到区域外，大概率是假阳性，需人工确认
 * failed  —— 完全没解析到坐标
 * manual  —— 人工指定
 * skipped —— 该节点类型无需落点（赶路 / 休整）
 */
export type GeocodeStatus = 'ok' | 'suspect' | 'failed' | 'manual' | 'skipped'

/** 点位实景图（高德 POI 图片，弹窗视觉用） */
export interface PoiPhoto {
  title: string
  url: string
}

export interface GuidePoiDto {
  id: string
  day_id: string | null
  seq: number
  /** 建议到达时间 'HH:mm' */
  arrive_time: string | null
  name: string
  kind: NodeKind
  priority: NodePriority
  city: string | null
  address: string | null
  lng: number | null
  lat: number | null
  stay_minutes: number | null
  /** 玩法描述（时间轴展示） */
  notes: string | null
  /** 避坑提醒（时间轴展示） */
  warnings: string | null
  /** 实用建议（时间轴展示） */
  tips: string | null
  /** 弹窗详细介绍：与时间轴内容分工，不在时间轴上展示 */
  detail: string | null
  /** 弹窗看点短句 */
  highlights: string[]
  /** 最佳时段 / 季节 */
  best_time: string | null
  /** 配图检索关键词（补图接口用） */
  photo_keywords: string[]
  /** 实景图，可能为空（弹窗会按需补图） */
  photos: PoiPhoto[]
  /** 距上一节点的里程（km） */
  leg_km: number | null
  geocode_status: GeocodeStatus
  geocode_provider: string | null
  verified: boolean
}

export interface GuideDayDto {
  id: string
  day_index: number
  title: string | null
  summary: string | null
  /** 路线串联：成都 → 都江堰 → 四姑娘山镇 */
  route_text: string | null
  /** 住宿地 */
  stay_text: string | null
  highlights: string | null
  cautions: string | null
  drive_km: number | null
  /** 车程文案，如 '4–5 h' */
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
  /** true = 跨天转移路段（上一日终点 → 次日起点），地图上画虚线 */
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

/** ---------- 整份保存（编辑器 → PUT /api/guide/:id）载荷 ---------- */

export interface GuideSavePoi {
  /** 已有节点带 id，原地更新；新节点不带 id */
  id?: string | null
  name: string
  kind: NodeKind
  priority: NodePriority
  arrive_time?: string | null
  stay_minutes?: number | null
  leg_km?: number | null
  city?: string | null
  address?: string | null
  lng?: number | null
  lat?: number | null
  notes?: string | null
  warnings?: string | null
  tips?: string | null
  /** 坐标是否为人工指定（地图拾取 / 手工输入） */
  manual?: boolean
}

export interface GuideSaveDay {
  id?: string | null
  day_index: number
  title?: string | null
  summary?: string | null
  route_text?: string | null
  stay_text?: string | null
  highlights?: string | null
  cautions?: string | null
  drive_km?: number | null
  drive_hours?: string | null
  sleep_altitude_m?: number | null
  max_altitude_m?: number | null
  notes?: string[]
  pois: GuideSavePoi[]
}

export interface GuideSavePayload {
  title?: string
  region?: string | null
  summary?: string | null
  days: GuideSaveDay[]
}

export interface GenerateIssue {
  poi: string
  day_index: number
  reason: string
  status: GeocodeStatus
  keyword?: string
  resolved?: { lng: number; lat: number }
}

export interface GenerateStats {
  totalNodes: number
  okCount: number
  suspectCount: number
  failedCount: number
  skippedCount: number
  elapsedMs: number
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number }
}
