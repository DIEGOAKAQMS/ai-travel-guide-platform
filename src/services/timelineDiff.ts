import type { GuideDto, GuideSavePayload } from '../types/guide'

/**
 * 时间轴编辑：算出这次保存**真正动了哪几天**。
 *
 * 背景：以前保存时间轴后会把整份行程都丢给 AI 重排，于是「只加了一个景点」
 * 也会让别的天一起被重排（顺序、时刻都可能变），用户完全无法预期。
 * 现在只把受影响的天交给 AI，其余天原样保留。
 *
 * 判定规则：
 * - 某天的节点集合 / 顺序变了（新增、删除、上下移动、挪进挪出）→ 该天受影响；
 * - 某天的出发地或当晚住宿地变了 → 该天连同**前一天与后一天**一起受影响
 *   （前一晚住哪决定次日几点出发，次日的落脚点也取决于当天住哪）。
 */

/** 节点序列的形状：已有节点用 id，新加的统一记作 new —— 只关心结构有没有变 */
function shapeOf(pois: { id?: string | null }[]): string {
  return pois.map((poi) => poi.id ?? 'new').join('|')
}

/**
 * 出发地 / 当晚住宿地是不是换了地方。
 *
 * 刻意按「原来那个节点还在不在、位置有没有被别的**已有**节点顶替」来判断，
 * 而不是直接比首尾节点 —— 用户把新景点追加到当天末尾时，末尾那个节点确实变了
 * （新节点成了最后一个），但住宿地本身没动，不该因此去动相邻的天。
 */
function endsChanged(
  before: { id?: string | null }[],
  after: { id?: string | null }[],
): boolean {
  if (before.length === 0 || after.length === 0) return false

  const beforeFirst = before[0].id ?? null
  const beforeLast = before[before.length - 1].id ?? null
  const afterFirst = after[0].id ?? null
  const afterLast = after[after.length - 1].id ?? null
  const afterIds = new Set(after.map((poi) => poi.id ?? null))

  // 出发地：起点被另一个已有节点顶替了（末尾追加新节点不算）
  const departureChanged = beforeFirst !== null && afterFirst !== null && afterFirst !== beforeFirst
  // 住宿地：原来那个住宿点被删掉 / 挪去了别的天，或末尾被另一个已有节点顶替
  const stayChanged =
    beforeLast !== null &&
    (!afterIds.has(beforeLast) || (afterLast !== null && afterLast !== beforeLast))

  return departureChanged || stayChanged
}

export function diffAffectedDays(guide: GuideDto, payload: GuideSavePayload): number[] {
  const beforeDays = new Map(guide.days.map((day) => [day.day_index, day.pois]))
  const afterDays = new Map(payload.days.map((day) => [day.day_index, day.pois ?? []]))
  const dayIndexes = [...new Set([...beforeDays.keys(), ...afterDays.keys()])]

  const affected = new Set<number>()

  for (const dayIndex of dayIndexes) {
    const beforePois = beforeDays.get(dayIndex) ?? []
    const afterPois = afterDays.get(dayIndex) ?? []

    // 结构变了（增删 / 换序 / 从别的天挪进来）→ 这一天要重排
    if (shapeOf(beforePois) !== shapeOf(afterPois)) affected.add(dayIndex)

    // 出发地 / 当晚住宿地换了地方 → 连同前后一天一起重排
    if (endsChanged(beforePois, afterPois)) {
      affected.add(dayIndex - 1)
      affected.add(dayIndex)
      affected.add(dayIndex + 1)
    }
  }

  return [...affected]
    .filter((dayIndex) => afterDays.has(dayIndex))
    .sort((a, b) => a - b)
}
