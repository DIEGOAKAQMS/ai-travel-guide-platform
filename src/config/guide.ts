import type { GeocodeStatus, NodeKind, NodePriority } from '@/types/guide'

/** 每天一种颜色，用于地图上区分行程天 */
export const DAY_COLORS = [
  '#2f7dfa',
  '#2ecc9b',
  '#f5a623',
  '#f05252',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#6366f1',
] as const

/** 取第 N 天（从 1 开始）的颜色 */
export function dayColor(dayIndex: number): string {
  const index = (dayIndex - 1) % DAY_COLORS.length
  return DAY_COLORS[index < 0 ? 0 : index]
}

/** 落点异常的颜色（越界 / 未命中） */
export const PROBLEM_COLOR = '#f05252'

/** 高亮路段的主色（与 CSS 变量 --highlight 一致） */
export const HIGHLIGHT_COLOR = '#1677ff'
/** 高亮路段的描边色（外圈那一圈蓝边） */
export const HIGHLIGHT_RING_COLOR = '#1677ff'
/** 高亮路段的芯色（描边内部那条细线） */
export const HIGHLIGHT_CORE_COLOR = '#ffffff'

/** 节点类型的中文名与图标 */
export const KIND_TEXT: Record<NodeKind, string> = {
  spot: '景点',
  view: '观景',
  town: '城镇',
  meal: '用餐',
  drive: '赶路',
  rest: '休整',
}

export const KIND_ICON: Record<NodeKind, string> = {
  spot: '▲',
  view: '◭',
  town: '⌂',
  meal: '☕',
  drive: '→',
  rest: '❊',
}

/** 节点类型对应的强调色（时间轴左侧圆点） */
export const KIND_COLOR: Record<NodeKind, string> = {
  spot: '#2f7dfa',
  view: '#06b6d4',
  town: '#a855f7',
  meal: '#f5a623',
  drive: '#64748b',
  rest: '#64748b',
}

/** 重要度文案，normal 不展示 */
export const PRIORITY_TEXT: Record<NodePriority, string> = {
  key: '关键',
  normal: '',
  optional: '可选',
}

/** 落点状态文案 */
export const STATUS_TEXT: Record<GeocodeStatus, string> = {
  ok: '已定位',
  suspect: '位置可疑',
  failed: '未定位',
  manual: '人工指定',
  skipped: '无需坐标',
}

/** 把分钟数格式化为「2 h 30 min」 */
export function formatStay(minutes: number | null): string {
  if (!minutes || minutes <= 0) return ''
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
