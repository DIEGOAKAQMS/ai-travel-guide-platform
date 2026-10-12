/** 时间轴到达时间重排：让节点之间的间隔 = 上一站停留时长 + 本段实际驾车耗时 */

/** 时间轴上的一个节点（只取排时间需要的字段） */
export interface ScheduleNode {
  id: string
  seq: number
  /** 模型的原始到达时间 'HH:mm'，用于锚定当天首站 / 没有真实路线时沿用原间隔 */
  arrive_time: string | null
  stay_minutes: number | null
}

/** 节点之间的一段真实驾车路线 */
export interface ScheduleLeg {
  from_poi_id: string | null
  to_poi_id: string | null
  /** 实际驾车耗时（秒） */
  duration_s: number | null
}

export interface ArrivalTimePatch {
  id: string
  arrive_time: string
}

/** 'HH:mm' → 一天内的分钟数；非法或缺失返回 null */
function parseClock(value: string | null): number | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim())
  if (!matched) return null
  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 分钟数 → 'HH:mm'；超出当天封顶到 23:59，避免出现 25:30 这种时间 */
function formatClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(Math.round(totalMinutes), 23 * 60 + 59))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

/**
 * 尽量往后取整到 10 分钟：'10:31' → '10:40'，本来就落在 10 分刻度上的不动。
 *
 * 只往后、不往前 —— 取整后的时间永远不早于实际需要的时间，
 * 于是后面每一站都从取整后的时刻往下推（多站会累积最多几分钟的余量）。
 */
function roundUpToTen(minutes: number): number {
  return Math.ceil(minutes / 10) * 10
}

/**
 * 重排一天内各节点的到达时间。
 *
 * 背景：arrive_time 是模型凭感觉写的，与 stay_minutes、高德实际耗时对不上，
 * 时间轴上会出现「A → B 的间隔 ≠ A 游玩时长 + 路上耗时」。这里以当天首个
 * 节点的到达时间为锚点逐站递推：
 * - 有真实路线的一段用高德耗时；
 * - 没有真实路线的段（如规划失败）沿用模型原本的间隔，不凭空猜测；
 * - 被真实路线「跨过」的无坐标节点（赶路 / 休整）不再单独计一次耗时，
 *   否则会和整段路线重复相加；
 * - 每一站的时间都往后取整到 10 分钟，时间轴上不会出现 13:37 这类零碎分钟。
 *
 * 返回需要改动的时间；当天首站没有合法时间时返回空数组（无从锚定，保持原样）。
 */
export function computeArrivalTimes(nodes: ScheduleNode[], legs: ScheduleLeg[]): ArrivalTimePatch[] {
  const ordered = [...nodes].sort((a, b) => a.seq - b.seq)
  if (ordered.length < 2) return []

  const anchor = parseClock(ordered[0].arrive_time)
  if (anchor === null) return []

  /** 抵达某节点的真实驾车耗时（分钟） */
  const durationTo = new Map<string, number>()
  for (const leg of legs) {
    if (!leg.to_poi_id || leg.duration_s === null) continue
    durationTo.set(leg.to_poi_id, Math.max(0, Math.round(leg.duration_s / 60)))
  }

  /** 被真实路线跨过的中间节点：耗时归整段路线，节点自身不再重复计一次 */
  const spanned = new Set<string>()
  for (const leg of legs) {
    if (!leg.from_poi_id || !leg.to_poi_id) continue
    const from = ordered.findIndex((node) => node.id === leg.from_poi_id)
    const to = ordered.findIndex((node) => node.id === leg.to_poi_id)
    if (from < 0 || to < 0 || to - from < 2) continue
    for (let i = from + 1; i < to; i += 1) spanned.add(ordered[i].id)
  }

  // 锚点也往后取整，整条时间轴才会都落在 10 分刻度上
  let cursor = roundUpToTen(anchor)
  const patches: ArrivalTimePatch[] = []
  if (formatClock(cursor) !== ordered[0].arrive_time) {
    patches.push({ id: ordered[0].id, arrive_time: formatClock(cursor) })
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]
    const cur = ordered[i]

    const real = durationTo.get(cur.id)
    let travelMinutes: number
    if (real !== undefined) {
      travelMinutes = real
    } else if (spanned.has(cur.id)) {
      travelMinutes = 0
    } else {
      const prevClock = parseClock(prev.arrive_time)
      const curClock = parseClock(cur.arrive_time)
      travelMinutes =
        prevClock !== null && curClock !== null
          ? Math.max(0, curClock - prevClock - (prev.stay_minutes ?? 0))
          : 0
    }

    cursor = roundUpToTen(cursor + (prev.stay_minutes ?? 0) + travelMinutes)
    const arriveTime = formatClock(cursor)
    if (arriveTime !== cur.arrive_time) patches.push({ id: cur.id, arrive_time: arriveTime })
  }

  return patches
}
