import { HIGHLIGHT_RING_COLOR, KIND_COLOR } from '@/config/guide'
import type { GuideDto, GuidePoiDto, NodeKind } from '@/types/guide'

/**
 * 地图要素的类型定义（渲染与右上角图例共用同一份，避免两边漂移）。
 *
 * - 图标类型：节点类型 + 住宿（由名称推断）+ 起点（行程第一个可落点节点）
 * - 图例分类：点位分类 + 两类线；其中「赶路」并入「起点」，不单独成类
 */

/** 点位图标类型 */
export type IconKey = NodeKind | 'lodging' | 'start'

/** 节点自身对应的图标（不含起点：起点由行程顺序判定后覆盖） */
export type BaseIconKey = 'spot' | 'view' | 'lodging' | 'meal' | 'rest' | 'drive'

/** 图例里的点位分类 */
export type PointKey = 'start' | 'spot' | 'view' | 'lodging' | 'meal' | 'rest'

/** 图例分类：点位分类 + 两类线 */
export type LegendKey = PointKey | 'route' | 'transfer'

/**
 * 24×24 的纯填充图形，会被嵌进「彩色圆底 + 白色图形」的 SVG 里。
 * 圆底颜色由调用方决定：地图上取当天路线色，图例里取类型代表色。
 */
const ICON_PATHS: Record<IconKey, string> = {
  // 景点：山峰
  spot: 'M2 19h20L15 7l-3.5 6-2-3z',
  // 观景：眼睛
  view: 'M12 6C7.2 6 3.6 8.9 2 12c1.6 3.1 5.2 6 10 6s8.4-2.9 10-6c-1.6-3.1-5.2-6-10-6zm0 9.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  // 用餐：碗 + 餐具
  meal: 'M3 11h18c0 5-4 9-9 9s-9-4-9-9zM19.5 3H22v18h-2.5z',
  // 住宿：房子
  lodging: 'M12 3 2.5 10.5V21H9v-6.5h6V21h6.5V10.5z',
  // 城镇：也是房子（与住宿同形，靠名称推断的 lodging 一致）
  town: 'M12 3 2.5 10.5V21H9v-6.5h6V21h6.5V10.5z',
  // 休整：月牙
  rest: 'M14 3a9 9 0 1 0 0 18 7 7 0 0 1 0-18z',
  // 赶路：右箭头（正常情况不会有坐标，兜底用）
  drive: 'M4 10.5h9V6l7 6-7 6v-4.5H4z',
  // 起点：旗子
  start: 'M4.6 3h2.3v18H4.6zM8.2 4.4h10.2l-3.4 3.9 3.4 3.9H8.2z',
}

const iconCache = new Map<string, string>()

/**
 * 标注外轮廓：
 * - select：选中 / 高亮路段端点 → 蓝色粗圈
 *
 * 以前还有一个绿色细圈（提示「可点击查看详情」），视觉上太吵，已去掉。
 */
export type RingKind = 'none' | 'select'

export const RING_COLOR: Record<Exclude<RingKind, 'none'>, string> = {
  select: HIGHLIGHT_RING_COLOR,
}

/** 生成「彩色圆底 + 白色图形」的 SVG data URI，可在外圈再加一圈轮廓 */
export function iconUri(key: IconKey, color: string, ring: RingKind = 'none'): string {
  const cacheKey = `${key}|${color}|${ring}`
  const cached = iconCache.get(cacheKey)
  if (cached) return cached

  const path = ICON_PATHS[key] ?? ICON_PATHS.spot
  const ringSvg =
    ring === 'none'
      ? ''
      : `<circle cx="20" cy="20" r="18.1" fill="none" stroke="${RING_COLOR[ring]}" stroke-width="3.2"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
    ringSvg +
    `<circle cx="20" cy="20" r="14.4" fill="${color}" stroke="#ffffff" stroke-width="2.4"/>` +
    `<g transform="translate(10 10) scale(0.8333)"><path d="${path}" fill="#ffffff"/></g>` +
    `</svg>`

  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  iconCache.set(cacheKey, uri)
  return uri
}

/** 名称里带这些词的一律按「住宿点」处理（兼容没有 kind 字段的旧数据） */
const LODGING_RE = /(酒店|宾馆|客栈|民宿|山庄|旅馆|招待所|驿站|青旅|营地|住宿|度假村)/

/** 节点本身对应的图标类型（「起点」需要按行程顺序单独判定后覆盖） */
export function baseIconKeyOf(poi: GuidePoiDto): BaseIconKey {
  if (poi.kind === 'town') return 'lodging'
  if (poi.kind === 'view' || poi.kind === 'meal' || poi.kind === 'rest' || poi.kind === 'drive') {
    return poi.kind
  }
  return LODGING_RE.test(poi.name) ? 'lodging' : 'spot'
}

/** 整条行程的起点：按天顺序第一个有坐标的节点 */
export function findStartPoiId(guide: GuideDto | null): string | null {
  if (!guide) return null
  for (const day of guide.days) {
    for (const poi of day.pois) {
      if (poi.lng !== null && poi.lat !== null) return poi.id
    }
  }
  return null
}

/**
 * 某个节点属于哪个图例分类（起点优先，一个点位只归属一类，便于按类显隐）。
 *
 * 「赶路」节点没有独立分类，统一并入「起点」，避免图例里挂一条几乎不出现的类型。
 */
export function legendKeyOf(poi: GuidePoiDto, startPoiId: string | null): PointKey {
  if (poi.id === startPoiId) return 'start'
  const icon = baseIconKeyOf(poi)
  return icon === 'drive' ? 'start' : icon
}

/** ---------- 右上角图例 ---------- */

export interface LegendPointItem {
  key: PointKey
  label: string
  shape: 'point'
  /** 图例里的代表色（地图上图标实际取当天颜色） */
  color: string
}

export interface LegendLineItem {
  key: 'route' | 'transfer'
  label: string
  shape: 'line'
  color: string
  /** 虚线（跨天转移路段在地图上就是虚线） */
  dash?: boolean
}

export type LegendItem = LegendPointItem | LegendLineItem

/** 图例的一行：条目 + 当前攻略里的数量 + 是否被隐藏 */
export interface LegendEntry {
  item: LegendItem
  count: number
  hidden: boolean
}

/** 图例条目定义（顺序即面板显示顺序） */
export const LEGEND_ITEMS: LegendItem[] = [
  { key: 'start', label: '起点 / 赶路', shape: 'point', color: '#12a06b' },
  { key: 'spot', label: '景点', shape: 'point', color: KIND_COLOR.spot },
  { key: 'view', label: '观景', shape: 'point', color: KIND_COLOR.view },
  { key: 'lodging', label: '住宿', shape: 'point', color: KIND_COLOR.town },
  { key: 'meal', label: '用餐', shape: 'point', color: KIND_COLOR.meal },
  { key: 'rest', label: '休整', shape: 'point', color: KIND_COLOR.rest },
  { key: 'route', label: '导航路线', shape: 'line', color: '#2f7dfa' },
  { key: 'transfer', label: '跨天转移', shape: 'line', color: '#8a97ab', dash: true },
]
