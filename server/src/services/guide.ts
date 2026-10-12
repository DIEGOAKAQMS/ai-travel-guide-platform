import { bboxForRegion } from '../config'
import { query, queryOne, withTransaction } from '../db/pool'
import { mapLimit } from '../utils/async'
import { geocodeAddress, searchPoi, type PlaceCandidate } from './amap'
import { planGuideStream, reviseGuideStream } from './llm'
import { geocodeByTianditu } from './tianditu'
import type {
  Bbox,
  GenerateIssue,
  GeocodeStatus,
  LlmDay,
  LlmGuide,
  LlmNode,
  NodeKind,
  NodePriority,
  ResolvedNode,
} from '../types'

const NODE_KINDS: NodeKind[] = ['spot', 'view', 'town', 'meal', 'drive', 'rest']
const NODE_PRIORITIES: NodePriority[] = ['key', 'normal', 'optional']

/** 容错：LLM 偶尔会写错枚举值，一律回落到默认值 */
function normalizeKind(kind?: string): NodeKind {
  return NODE_KINDS.includes(kind as NodeKind) ? (kind as NodeKind) : 'spot'
}

function normalizePriority(priority?: string): NodePriority {
  return NODE_PRIORITIES.includes(priority as NodePriority) ? (priority as NodePriority) : 'normal'
}

/** 赶路 / 休整类节点没有真实地点，不需要落点 */
function needsGeocode(kind: NodeKind): boolean {
  return kind !== 'drive' && kind !== 'rest'
}

/**
 * 从「西宁出发」这类当天起点节点里抽出真实地名。
 *
 * 背景：`drive` 类节点默认不落点，但「XX出发」是当天行程的实际起点
 * （就是前一晚的住宿地）。如果不给它坐标，当天第一段导航
 * （如 西宁 → 塔尔寺 30km）就会整段丢失，地图上行程从第二站才开始。
 */
function departurePlaceName(name: string, kind: NodeKind): string | null {
  if (kind !== 'drive') return null
  const matched = /^(.+?)(?:出发|启程)$/.exec(name.trim())
  if (!matched) return null
  const place = matched[1].replace(/[（(][^）)]*[)）]/g, '').trim()
  return place || null
}

/**
 * 节点名里的「动作 / 状态」词：它们不是地名的一部分，检索前必须去掉。
 *
 * 「观景」单独放开：只去掉后面不接「台 / 点」的那种（「牦牛河谷观景」是模型
 * 编的说法，要去掉；「猫鼻梁观景台」是真实 POI，改了就搜不到了）。
 */
const ACTION_WORDS =
  /(出发|启程|返回|住宿|入住|退房|夜宿|抵达|途经|经过|休整|补给|早餐|午餐|中餐|晚餐|夜宵|用餐|吃饭|美食|观景(?!台|点))/g

/**
 * 关键词是「行政区 / 地名」型（丹巴县城、新都桥镇、赤峰市区、克什克腾旗…）还是「POI / 景区」型。
 *
 * 地名型用「行政区前缀 + /geocode」最准；POI 型用关键字搜索最准。
 * 「景区 / 林区 / 服务区」这类以「区」结尾的其实是 POI，不算行政区（否则双桥沟景区会走错分支）。
 */
const ADMIN_SUFFIX = /(县城|城区|市区|市|县|区|镇|乡|旗|盟|州|村|街道)$/
const NON_ADMIN_SUFFIX = /(景区|林区|矿区|开发区|风景区|服务区|牧区|垦区|特区)$/

function isAdminKeyword(keyword: string): boolean {
  if (NON_ADMIN_SUFFIX.test(keyword)) return false
  return ADMIN_SUFFIX.test(keyword)
}

/** 去掉地点名里的修饰词，得到可用于比对 / 检索的核心地名 */
function coreName(name: string): string {
  return name
    .replace(/[（(][^）)]*[)）]/g, '')
    .replace(ACTION_WORDS, '')
    .replace(/[\s·—\-–>→]+/g, '')
    .trim()
}

/**
 * 节点名里可供检索的地名候选。
 *
 * 背景：name 是「地名 + 动作」，整串拿去检索会命中风马牛不相及的地点 ——
 * 实测 `理县县城入住` 会返回红原县（直线 160 km 外，却仍在区域包围盒内，
 * 一路被当成 ok 采纳），`牦牛河谷观景` 会返回康定市区的观景民宿。
 * 去掉动作词后的 `理县县城` / `牦牛河谷` 才搜得到真正的地方。
 *
 * 括号里的补充说明（餐厅名等）作为备选关键词，用来落得更精确。
 */
export function searchKeywords(name: string): string[] {
  const keywords: string[] = []

  const core = coreName(name)
  if (core.length >= 2) keywords.push(core)

  const brackets = [...name.matchAll(/[（(]([^）)]+)[)）]/g)]
    .map((matched) => matched[1].replace(/[\s·—\-–>→]+/g, '').trim())
    // 括号里若是「约 80 km」「海拔 3200 米」这类说明，不是地名，跳过
    .filter((item) => item.length >= 2 && !/\d/.test(item))

  for (const item of brackets) {
    if (!keywords.includes(item)) keywords.push(item)
  }
  return keywords
}

/** 两个地名是否指向同一处（互相包含即认为衔接） */
function isConnected(prevName: string, curName: string): boolean {
  const a = coreName(prevName)
  const b = coreName(curName)
  if (!a || !b) return true
  return a.includes(b) || b.includes(a)
}

/**
 * 跨日衔接修复
 *
 * LLM 偶尔会「重置」路线：第 1 天晚上住四姑娘山镇，第 2 天却从成都出发，
 * 于是时间轴和地图上的行程断成两截。
 * 这里逐日检查首节点是否承接上一日的末节点，不承接就补一个「XX 出发」的赶路节点。
 */
function stitchDays(days: LlmDay[]): void {
  for (const day of days) {
    if (!Array.isArray(day.timeline)) day.timeline = []
  }

  for (let i = 1; i < days.length; i += 1) {
    const prevDay = days[i - 1]
    const day = days[i]
    const prevLast = prevDay.timeline[prevDay.timeline.length - 1]
    const current = day.timeline[0]
    if (!prevLast || !current) continue
    if (isConnected(prevLast.name, current.name)) continue

    const place = coreName(prevLast.name) || prevLast.name
    const connector: LlmNode = {
      name: `${place}出发`,
      kind: 'drive',
      priority: 'normal',
      stay_minutes: 0,
      leg_km: 0,
      desc: `承接第 ${prevDay.day_index} 天的终点「${prevLast.name}」，从这里继续出发。`,
    }
    day.timeline.unshift(connector)
    console.warn(
      `[guide] 第 ${day.day_index} 天起点「${current.name}」未承接第 ${prevDay.day_index} 天终点` +
        `「${prevLast.name}」，已自动补「${connector.name}」节点`,
    )
  }
}

/** 从「四川省甘孜州稻城县」中抽出可用于高德 city 参数的「甘孜州」 */
export function shortCity(fullAddress?: string): string | undefined {
  if (!fullAddress) return undefined
  const withoutProvince = fullAddress.replace(/^.*?(?:省|自治区|特别行政区)/, '')
  const matched = /^(.*?[市州盟])/.exec(withoutProvince)
  if (matched) return matched[1]
  return withoutProvince || undefined
}

function insideBbox(lng: number, lat: number, bbox: Bbox): boolean {
  return lng >= bbox.minLng && lng <= bbox.maxLng && lat >= bbox.minLat && lat <= bbox.maxLat
}

/** 在候选集中优先取落在区域内的，取不到再退而求其次 */
function pickCandidate(
  candidates: PlaceCandidate[],
  bbox: Bbox,
): { candidate: PlaceCandidate; inBbox: boolean } | null {
  if (candidates.length === 0) return null
  const inside = candidates.find((item) => insideBbox(item.lng, item.lat, bbox))
  if (inside) return { candidate: inside, inBbox: true }
  return { candidate: candidates[0], inBbox: false }
}

/** 两点间球面距离（米） */
function distanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 中位数 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 落点离群复核 —— 兜住「点位飞到几千公里外」。
 *
 * 背景：区域名认不出来时 bbox 会退化成「中国」范围，等于把越界校验关掉；
 * 而高德的结构化地理编码 / 关键字搜索都可能给出跨省的同名点
 * （实测「阿斯哈图石林」→ 云南石林 2350 km、「热水塘」→ 云南保山 2552 km），
 * 这些点会以 ok 的状态混进攻略，在图上就是「飞得很远」。
 *
 * 做法：用所有已落点节点的**中位数中心**算距离分布（中位数不受离群点影响），
 * 按 Tukey 上界 Q3 + 3×IQR（下限 300 km）找出离群点，再以中心为界收紧包围盒重解一次：
 * - 重解落在紧凑范围内 → 采用（多半就是同名地点的正确出处）；
 * - 重解不出来 → 保留原坐标但降级为 suspect，给出提示交人工校正，不再冒充 ok。
 */
export async function refineOutliers(
  results: { resolved: ResolvedNode; issue?: GenerateIssue }[],
  flat: { node: LlmNode; dayIndex: number; seq: number }[],
  bbox: Bbox,
): Promise<void> {
  const located = results
    .map((item, index) => ({ index, lng: item.resolved.lng, lat: item.resolved.lat }))
    .filter(
      (item): item is { index: number; lng: number; lat: number } =>
        typeof item.lng === 'number' && typeof item.lat === 'number',
    )
  if (located.length < 5) return

  const center = {
    lng: median(located.map((item) => item.lng)),
    lat: median(located.map((item) => item.lat)),
  }
  const distances = located.map((item) => distanceM(center, item))
  const sorted = [...distances].sort((a, b) => a - b)
  const q1 = median(sorted.slice(0, Math.floor(sorted.length / 2)))
  const q3 = median(sorted.slice(Math.ceil(sorted.length / 2)))
  const upper = Math.max(q3 + 3 * (q3 - q1), 300_000)

  const outliers = located.filter((_, index) => distances[index] > upper)
  if (outliers.length === 0) return

  // 紧凑范围：以中位数中心为圆心，半径取离群门槛（限制在 200~800 km）
  const radiusKm = Math.min(Math.max(upper / 1000, 200), 800)
  const latSpan = radiusKm / 111
  const lngSpan = radiusKm / (111 * Math.max(Math.cos((center.lat * Math.PI) / 180), 0.2))
  const tightBbox: Bbox = {
    minLng: center.lng - lngSpan,
    maxLng: center.lng + lngSpan,
    minLat: center.lat - latSpan,
    maxLat: center.lat + latSpan,
  }
  const tighter =
    tightBbox.minLng > bbox.minLng ||
    tightBbox.maxLng < bbox.maxLng ||
    tightBbox.minLat > bbox.minLat ||
    tightBbox.maxLat < bbox.maxLat
  if (!tighter) return

  console.log(`[guide] 落点离群复核：${outliers.length} 个节点距行程中心过远，收紧范围重解`)

  await mapLimit(outliers, 3, async ({ index }) => {
    const item = flat[index]
    const before = results[index]
    if (!item || !before) return

    const retry = await resolveNode(item.node, item.dayIndex, item.seq, tightBbox)
    if (retry.resolved.geocode_status === 'ok') {
      // 只有「明显更靠近行程中心」才采纳：北京、塞罕坝这类正常的长腿点位
      // 也会被判成离群，重解只会给出换个门牌号的等价结果，采纳它纯属来回抖动。
      const beforeDistance = distanceM(center, {
        lng: before.resolved.lng ?? 0,
        lat: before.resolved.lat ?? 0,
      })
      const retryDistance = distanceM(center, {
        lng: retry.resolved.lng ?? 0,
        lat: retry.resolved.lat ?? 0,
      })
      if (retryDistance < beforeDistance * 0.7) {
        results[index] = retry
        console.log(
          `[guide] 复核修正「${item.node.name}」→ ${retry.resolved.geocode_keyword}` +
            `（${Math.round(beforeDistance / 1000)} km → ${Math.round(retryDistance / 1000)} km）`,
        )
      }
      return
    }

    if (before.resolved.geocode_status === 'ok') {
      const stray = Math.round(
        distanceM(center, {
          lng: before.resolved.lng ?? 0,
          lat: before.resolved.lat ?? 0,
        }) / 1000,
      )
      // 只在「远得离谱」时降级：像乌兰布统这种一半点位挤在小范围的行程，
      // 北京、塞罕坝这类正常的长腿点位也会被判成离群，重解不出来时不该冤枉它们。
      if (stray > 1000) {
        results[index] = {
          resolved: { ...before.resolved, geocode_status: 'suspect' },
          issue: {
            poi: item.node.name,
            day_index: item.dayIndex,
            status: 'suspect',
            keyword: before.resolved.geocode_keyword ?? '',
            reason: `落点距行程中心约 ${stray} km，远超同行程其它点位，疑似同名地点串省，建议人工校正`,
            resolved: { lng: before.resolved.lng ?? 0, lat: before.resolved.lat ?? 0 },
          },
        }
      }
    }
  })
}

interface Attempt {
  /** 用于追溯的关键词 */
  label: string
  run: () => Promise<PlaceCandidate[]>
}

/** 容错：LLM 偶尔把数组写成字符串（或塞进逗号分隔），统一成干净的字符串数组 */
function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,、;；]/) : []
  return raw
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
}

/** 节点在库中的公共字段（与坐标无关），三种分支共用 */
function baseNode(node: LlmNode, dayIndex: number, seq: number, kind: NodeKind, priority: NodePriority) {
  return {
    day_index: dayIndex,
    seq,
    time: node.time,
    name: node.name,
    kind,
    priority,
    city: node.city,
    desc: node.desc,
    warnings: node.warnings,
    tips: node.tips,
    // 弹窗专用内容：时间轴不展示，与 desc / warnings / tips 分工
    detail: node.detail,
    highlights: toStringList(node.highlights),
    best_time: node.best_time,
    photo_keywords: toStringList(node.photo_keywords),
    leg_km: node.leg_km,
    stay_minutes: node.stay_minutes,
  }
}

function formatAddress(candidate: PlaceCandidate): string {
  return [candidate.province, candidate.city, candidate.district, candidate.address]
    .filter(Boolean)
    .join('')
    .slice(0, 200)
}

/**
 * 单个行程节点的落点解析
 *
 * 策略：按「行政区限定 → 不限区域 → 结构化地址 → 天地图兜底」依次尝试，
 * 只要有一轮命中目标 bbox 就立即采纳；若所有尝试都越界，
 * 则保留第一个越界结果并标记为 suspect（交由人工校正），而不是直接丢弃。
 *
 * 赶路 / 休整类节点直接标记为 skipped，不消耗任何地图配额。
 */
async function resolveNode(
  node: LlmNode,
  dayIndex: number,
  seq: number,
  bbox: Bbox,
): Promise<{ resolved: ResolvedNode; issue?: GenerateIssue }> {
  const kind = normalizeKind(node.kind)
  const priority = normalizePriority(node.priority)
  const base = baseNode(node, dayIndex, seq, kind, priority)

  // 「西宁出发」这类起点节点虽然是 drive，但要按真实地点落点
  const departure = departurePlaceName(node.name, kind)
  // 其它节点也带去动作词后的地名：「理县县城入住」→「理县县城」、「巴朗山垭口」原样
  const derived = searchKeywords(node.name)

  if (!needsGeocode(kind) && !departure) {
    return { resolved: { ...base, geocode_status: 'skipped' } }
  }

  /** 实际用于检索的词：去掉「出发 / 入住 / 晚餐 / 观景」这类动作词后的地名 */
  const keyword = departure ?? derived[0] ?? node.name
  /**
   * 备选关键词：括号里的餐厅名等；若主关键词是从原名「削」出来的，
   * 原名本身也排到最后兜底（削错了至少还能退回老行为）。
   */
  const altKeywords = departure
    ? []
    : [...derived.slice(1), ...(keyword !== node.name ? [node.name] : [])]
  const city = shortCity(node.city) ?? node.city
  const attempts: Attempt[] = []

  /**
   * 单个关键词的落点尝试顺序。
   *
   * 两类关键词的脾气完全不同（都是实测结论）：
   * - 行政区 / 地名型（「丹巴县城」「新都桥镇」「赤峰市区」）：`城市前缀 + /geocode` 最准，
   *   而 POI 关键字搜索会优先返回同名的酒店、公司（「丹巴县城」第一条是「丹巴县袖珍城客栈」）。
   * - POI / 景区型（「阿斯哈图石林」「双桥沟景区」「热水塘温泉」）：关键字搜索最准，
   *   而裸关键词做结构化地理编码会跨省乱配（「阿斯哈图石林」→ 云南石林、「热水塘」→ 云南保山）。
   *
   * 所以：地名型先 /geocode，POI 型先关键字搜索；两者都**必须带行政区限定**，
   * 裸关键词的 /geocode 彻底不再使用 —— 它本身就是最主要的跨省误配来源。
   */
  const addAttempts = (target: string, preferGeocode: boolean) => {
    const pushGeocode = (label: string, address: string) => {
      attempts.push({
        label,
        run: async () => {
          const one = await geocodeAddress(address)
          return one ? [one] : []
        },
      })
    }
    const pushPoi = (label: string, withCity: boolean) => {
      attempts.push({
        label,
        run: () => searchPoi(target, withCity ? { city, limit: 5 } : { limit: 5 }),
      })
    }

    if (preferGeocode && city) {
      pushGeocode(`amap-geo|${city}${target}`, `${city}${target}`)
      pushPoi(`amap-poi|${city}|${target}`, true)
    } else {
      if (city) pushPoi(`amap-poi|${city}|${target}`, true)
      if (city) pushGeocode(`amap-geo|${city}${target}`, `${city}${target}`)
    }

    pushPoi(`amap-poi|${target}`, false)
  }

  addAttempts(keyword, isAdminKeyword(keyword))
  for (const alt of altKeywords) addAttempts(alt, false)

  let outOfBbox: { candidate: PlaceCandidate; label: string } | null = null

  for (const attempt of attempts) {
    let candidates: PlaceCandidate[] = []
    try {
      candidates = await attempt.run()
    } catch (error) {
      console.warn(`[guide] 落点尝试失败 ${attempt.label}：${(error as Error).message}`)
      continue
    }

    const picked = pickCandidate(candidates, bbox)
    if (!picked) continue

    if (picked.inBbox) {
      const { candidate } = picked
      return {
        resolved: {
          ...base,
          address: formatAddress(candidate),
          lng: Number(candidate.lng.toFixed(6)),
          lat: Number(candidate.lat.toFixed(6)),
          lng_gcj: Number(candidate.lngGcj.toFixed(6)),
          lat_gcj: Number(candidate.latGcj.toFixed(6)),
          // 顺手把高德 POI 的实景图带上，弹窗直接用
          photos: candidate.photos,
          geocode_status: 'ok',
          geocode_provider: 'amap',
          geocode_keyword: attempt.label,
        },
      }
    }

    if (!outOfBbox) {
      outOfBbox = { candidate: picked.candidate, label: attempt.label }
    }
  }

  // 天地图兜底（返回 WGS84，无需坐标转换）
  // 注意：天地图对「行政区+景点名」这种拼接词命中率反而低，
  // 因此先试拼接词，再退化为纯景点名。
  let outOfBboxTianditu: { lng: number; lat: number; score: number; keyword: string } | null = null
  const tiandituKeywords: string[] = []
  if (city) tiandituKeywords.push(`${city}${keyword}`)
  if (!tiandituKeywords.includes(keyword)) tiandituKeywords.push(keyword)

  for (const tdKeyword of tiandituKeywords) {
    const td = await geocodeByTianditu(tdKeyword)
    if (!td) continue

    if (insideBbox(td.lng, td.lat, bbox)) {
      return {
        resolved: {
          ...base,
          lng: Number(td.lng.toFixed(6)),
          lat: Number(td.lat.toFixed(6)),
          geocode_status: 'ok',
          geocode_score: td.score,
          geocode_provider: 'tianditu',
          geocode_keyword: tdKeyword,
        },
      }
    }

    if (!outOfBboxTianditu) {
      outOfBboxTianditu = { lng: td.lng, lat: td.lat, score: td.score, keyword: tdKeyword }
    }
  }

  // 两家都落到区域外时，优先采信高德（POI 精度更高），标记为待人工确认
  if (outOfBbox) {
    const { candidate, label } = outOfBbox
    return {
      resolved: {
        ...base,
        address: formatAddress(candidate),
        lng: Number(candidate.lng.toFixed(6)),
        lat: Number(candidate.lat.toFixed(6)),
        lng_gcj: Number(candidate.lngGcj.toFixed(6)),
        lat_gcj: Number(candidate.latGcj.toFixed(6)),
        photos: candidate.photos,
        geocode_status: 'suspect',
        geocode_provider: 'amap',
        geocode_keyword: label,
      },
      issue: {
        poi: node.name,
        day_index: dayIndex,
        status: 'suspect',
        keyword: label,
        reason: `高德解析到区域外（${candidate.lng.toFixed(4)}, ${candidate.lat.toFixed(4)}），疑似同名地点，建议人工校正`,
        resolved: { lng: candidate.lng, lat: candidate.lat },
      },
    }
  }

  if (outOfBboxTianditu) {
    const { lng, lat, score, keyword } = outOfBboxTianditu
    return {
      resolved: {
        ...base,
        lng: Number(lng.toFixed(6)),
        lat: Number(lat.toFixed(6)),
        geocode_status: 'suspect',
        geocode_score: score,
        geocode_provider: 'tianditu',
        geocode_keyword: keyword,
      },
      issue: {
        poi: node.name,
        day_index: dayIndex,
        status: 'suspect',
        keyword,
        reason: `天地图解析到区域外（${lng.toFixed(4)}, ${lat.toFixed(4)}），疑似同名地点，建议人工校正`,
        resolved: { lng, lat },
      },
    }
  }

  return {
    resolved: { ...base, geocode_status: 'failed' },
    issue: {
      poi: node.name,
      day_index: dayIndex,
      status: 'failed',
      reason: '所有地理编码尝试均未命中，需人工指定位置',
    },
  }
}

export interface GenerateResult {
  guideId: string
  issues: GenerateIssue[]
  stats: {
    totalNodes: number
    okCount: number
    suspectCount: number
    failedCount: number
    skippedCount: number
    usage: { promptTokens: number; completionTokens: number; reasoningTokens: number }
  }
}

/** 生成过程中的进度事件，用于 SSE 推送给前端 */
export type GenerateEvent =
  | { type: 'stage'; stage: string; message: string }
  /** 模型思考增量 */
  | { type: 'reasoning'; text: string }
  /** 单个节点落点完成 */
  | { type: 'poi'; done: number; total: number; name: string; status: GeocodeStatus }

/** 一句话 → 完整攻略（含落点、校验、入库） */
export async function generateGuide(
  input: { prompt: string; days?: number; region?: string },
  onEvent?: (event: GenerateEvent) => void,
): Promise<GenerateResult> {
  onEvent?.({ type: 'stage', stage: 'planning', message: '正在理解需求并规划行程骨架…' })

  const { guide: llmGuide, usage } = await planGuideStream(
    input.prompt,
    { days: input.days, region: input.region },
    (delta) => {
      if (delta.reasoning) onEvent?.({ type: 'reasoning', text: delta.reasoning })
    },
  )

  onEvent?.({
    type: 'stage',
    stage: 'planned',
    message: `行程骨架完成，共 ${llmGuide.days.length} 天`,
  })

  const region = input.region ?? llmGuide.region
  const [minLng, minLat, maxLng, maxLat] = bboxForRegion(region)
  const bbox: Bbox = { minLng, minLat, maxLng, maxLat }

  // 跨日衔接修复：保证第 N 天从第 N-1 天的终点出发
  stitchDays(llmGuide.days)

  // 打平为待落点的节点列表（含无需落点的赶路 / 休整节点，便于前端看到完整时间轴）
  const flat: { node: LlmNode; dayIndex: number; seq: number }[] = []
  for (const day of llmGuide.days) {
    ;(day.timeline ?? []).forEach((node, index) => {
      flat.push({ node, dayIndex: day.day_index, seq: index })
    })
  }

  const geocodeTotal = flat.filter((item) => needsGeocode(normalizeKind(item.node.kind))).length

  onEvent?.({
    type: 'stage',
    stage: 'geocoding',
    message: `正在逐个解析 ${geocodeTotal} 个节点的坐标…`,
  })

  let doneCount = 0
  const results = await mapLimit(flat, 4, async ({ node, dayIndex, seq }) => {
    const result = await resolveNode(node, dayIndex, seq, bbox)
    doneCount += 1
    onEvent?.({
      type: 'poi',
      done: doneCount,
      total: flat.length,
      name: node.name,
      status: result.resolved.geocode_status,
    })
    return result
  })

  // 跨省长串点复核（区域名陌生时 bbox 会退化成全国，这一步兜住）
  await refineOutliers(results, flat, bbox)

  const resolvedNodes = results.map((item) => item.resolved)
  const issues = results
    .map((item) => item.issue)
    .filter((item): item is GenerateIssue => item !== undefined)

  onEvent?.({ type: 'stage', stage: 'persisting', message: '正在写入数据库…' })

  const guideId = await persistGuide({
    title: llmGuide.title || input.prompt.slice(0, 50),
    region: region ?? null,
    prompt: input.prompt,
    summary: llmGuide.summary ?? null,
    llmGuide,
    resolvedNodes,
  })

  onEvent?.({ type: 'stage', stage: 'done', message: '攻略生成完成' })

  return {
    guideId,
    issues,
    stats: {
      totalNodes: resolvedNodes.length,
      okCount: resolvedNodes.filter((item) => item.geocode_status === 'ok').length,
      suspectCount: resolvedNodes.filter((item) => item.geocode_status === 'suspect').length,
      failedCount: resolvedNodes.filter((item) => item.geocode_status === 'failed').length,
      skippedCount: resolvedNodes.filter((item) => item.geocode_status === 'skipped').length,
      usage,
    },
  }
}

/** 安全取数：字符串数字 / null → number | null */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 在一个事务客户端内写入「天 + 节点」（调用方负责 guide 主表与清理旧数据） */
async function writeDaysAndPois(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  guideId: string,
  llmGuide: LlmGuide,
  resolvedNodes: ResolvedNode[],
): Promise<void> {
  const dayIdByIndex = new Map<number, string>()
  for (const day of llmGuide.days) {
    const dayResult = (await client.query(
      `INSERT INTO guide_day (
         guide_id, day_index, title, summary,
         route_text, stay_text, highlights, cautions,
         drive_km, drive_hours, sleep_altitude_m, max_altitude_m, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        guideId,
        day.day_index,
        day.title ?? null,
        day.summary ?? null,
        day.route ?? null,
        day.stay ?? null,
        day.highlights ?? null,
        day.cautions ?? null,
        day.drive_km ?? null,
        day.drive_hours ?? null,
        day.sleep_altitude_m ?? null,
        day.max_altitude_m ?? null,
        JSON.stringify(day.notes ?? []),
      ],
    )) as { rows: { id: string }[] }
    dayIdByIndex.set(day.day_index, dayResult.rows[0].id)
  }

  for (const node of resolvedNodes) {
    await client.query(
      `INSERT INTO guide_poi (
         guide_id, day_id, seq, name, kind, priority, city, address,
         lng, lat, lng_gcj, lat_gcj,
         arrive_time, stay_minutes, notes, warnings, tips, leg_km,
         detail, highlights, best_time, photo_keywords, photos,
         geocode_status, geocode_score, geocode_provider, geocode_keyword
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        guideId,
        dayIdByIndex.get(node.day_index) ?? null,
        node.seq,
        node.name,
        node.kind,
        node.priority,
        node.city ?? null,
        node.address ?? null,
        node.lng ?? null,
        node.lat ?? null,
        node.lng_gcj ?? null,
        node.lat_gcj ?? null,
        node.time ?? null,
        node.stay_minutes ?? null,
        node.desc ?? null,
        node.warnings ?? null,
        node.tips ?? null,
        node.leg_km ?? null,
        node.detail ?? null,
        JSON.stringify(node.highlights ?? []),
        node.best_time ?? null,
        JSON.stringify(node.photo_keywords ?? []),
        JSON.stringify(node.photos ?? []),
        node.geocode_status,
        node.geocode_score ?? null,
        node.geocode_provider ?? null,
        node.geocode_keyword ?? null,
      ],
    )
  }
}

/** 落库：guide + guide_day + guide_poi */
async function persistGuide(input: {
  title: string
  region: string | null
  prompt: string
  summary: string | null
  llmGuide: LlmGuide
  resolvedNodes: ResolvedNode[]
}): Promise<string> {
  return withTransaction(async (client) => {
    const guideResult = await client.query<{ id: string }>(
      `INSERT INTO guide (title, region, prompt, summary, total_days, raw_llm)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.title,
        input.region,
        input.prompt,
        input.summary,
        input.llmGuide.total_days ?? input.llmGuide.days.length,
        JSON.stringify(input.llmGuide),
      ],
    )
    const guideId = guideResult.rows[0].id
    await writeDaysAndPois(client, guideId, input.llmGuide, input.resolvedNodes)
    return guideId
  })
}

// ---------------------------------------------------------------------------
// 改稿：在当前攻略基础上按用户要求重写
// ---------------------------------------------------------------------------

export interface ReviseInput {
  guideId: string
  instruction: string
}

interface GuideSnapshot {
  meta: { id: string; title: string; region: string | null; summary: string | null }
  llmGuide: LlmGuide
  /** 「天序号|节点名」→ 已落点信息，改稿时同名节点直接复用坐标，避免重新检索 */
  reuse: Map<string, ResolvedNode>
}

/** 读取当前攻略并转换为 LLM 结构，同时建立坐标复用表 */
async function loadGuideSnapshot(guideId: string): Promise<GuideSnapshot | null> {
  const meta = await queryOne<{
    id: string
    title: string
    region: string | null
    summary: string | null
  }>('SELECT id, title, region, summary FROM guide WHERE id = $1', [guideId])
  if (!meta) return null

  const dayRows = await query<{
    id: string
    day_index: number
    title: string | null
    summary: string | null
    route_text: string | null
    stay_text: string | null
    highlights: string | null
    cautions: string | null
    drive_km: string | null
    drive_hours: string | null
    sleep_altitude_m: number | null
    max_altitude_m: number | null
    notes: unknown
  }>(
    `SELECT id, day_index, title, summary, route_text, stay_text, highlights, cautions,
            drive_km, drive_hours, sleep_altitude_m, max_altitude_m, notes
       FROM guide_day WHERE guide_id = $1 ORDER BY day_index`,
    [guideId],
  )

  const poiRows = await query<{
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
    lng_gcj: number | null
    lat_gcj: number | null
    stay_minutes: number | null
    notes: string | null
    warnings: string | null
    tips: string | null
    detail: string | null
    highlights: unknown
    best_time: string | null
    photo_keywords: unknown
    photos: unknown
    leg_km: string | null
    geocode_status: GeocodeStatus
    geocode_provider: string | null
    geocode_keyword: string | null
  }>(
    `SELECT id, day_id, seq, arrive_time, name, kind, priority, city, address,
            lng, lat, lng_gcj, lat_gcj, stay_minutes, notes, warnings, tips, leg_km,
            detail, highlights, best_time, photo_keywords, photos,
            geocode_status, geocode_provider, geocode_keyword
       FROM guide_poi WHERE guide_id = $1 ORDER BY seq`,
    [guideId],
  )

  const reuse = new Map<string, ResolvedNode>()

  const days: LlmDay[] = dayRows.map((day) => {
    const dayPois = poiRows
      .filter((poi) => poi.day_id === day.id)
      .sort((a, b) => a.seq - b.seq)

    for (const poi of dayPois) {
      if (poi.lng === null || poi.lat === null) continue
      reuse.set(`${day.day_index}|${poi.name}`, {
        day_index: day.day_index,
        seq: poi.seq,
        name: poi.name,
        kind: poi.kind,
        priority: poi.priority,
        lng: poi.lng,
        lat: poi.lat,
        lng_gcj: poi.lng_gcj ?? undefined,
        lat_gcj: poi.lat_gcj ?? undefined,
        address: poi.address ?? undefined,
        // 坐标复用时连实景图一起带走，否则改稿后弹窗的图会丢
        photos: Array.isArray(poi.photos) ? (poi.photos as ResolvedNode['photos']) : [],
        geocode_status: poi.geocode_status,
        geocode_provider: poi.geocode_provider ?? undefined,
        geocode_keyword: poi.geocode_keyword ?? undefined,
      })
    }

    return {
      day_index: day.day_index,
      title: day.title ?? undefined,
      summary: day.summary ?? undefined,
      route: day.route_text ?? undefined,
      stay: day.stay_text ?? undefined,
      highlights: day.highlights ?? undefined,
      cautions: day.cautions ?? undefined,
      drive_km: num(day.drive_km) ?? undefined,
      drive_hours: day.drive_hours ?? undefined,
      sleep_altitude_m: day.sleep_altitude_m ?? undefined,
      max_altitude_m: day.max_altitude_m ?? undefined,
      notes: Array.isArray(day.notes) ? (day.notes as string[]) : [],
      timeline: dayPois.map((poi) => ({
        time: poi.arrive_time ?? undefined,
        name: poi.name,
        kind: poi.kind,
        city: poi.city ?? undefined,
        stay_minutes: poi.stay_minutes ?? undefined,
        priority: poi.priority,
        desc: poi.notes ?? undefined,
        warnings: poi.warnings ?? undefined,
        tips: poi.tips ?? undefined,
        // 弹窗内容交给 LLM 原样沿用（提示词里已明确要求不改写）
        detail: poi.detail ?? undefined,
        highlights: toStringList(poi.highlights),
        best_time: poi.best_time ?? undefined,
        photo_keywords: toStringList(poi.photo_keywords),
        leg_km: num(poi.leg_km) ?? undefined,
      })),
    }
  })

  return {
    meta,
    llmGuide: {
      title: meta.title,
      region: meta.region ?? undefined,
      summary: meta.summary ?? undefined,
      total_days: days.length,
      days,
    },
    reuse,
  }
}

/** 用改稿结果整体替换某份攻略的内容（天/点重建，原路线需重新规划） */
async function replaceGuideContent(input: {
  guideId: string
  title: string
  region: string | null
  summary: string | null
  prompt: string
  llmGuide: LlmGuide
  resolvedNodes: ResolvedNode[]
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE guide
          SET title = $2, region = $3, summary = $4, total_days = $5,
              prompt = $6, raw_llm = $7, status = 'draft', updated_at = now()
        WHERE id = $1`,
      [
        input.guideId,
        input.title,
        input.region,
        input.summary,
        input.llmGuide.total_days ?? input.llmGuide.days.length,
        input.prompt,
        JSON.stringify(input.llmGuide),
      ],
    )
    // guide_day 级联删除其下 guide_poi 与 guide_route，随后整体重建
    await client.query('DELETE FROM guide_day WHERE guide_id = $1', [input.guideId])
    await writeDaysAndPois(client, input.guideId, input.llmGuide, input.resolvedNodes)
  })
}

/**
 * 改稿：读取当前攻略 → LLM 按指令重写 → 复用/重算坐标 → 覆盖写回。
 * 与 generateGuide 的区别：不改 guide.id，原地更新内容。
 */
export async function reviseGuide(
  input: ReviseInput,
  onEvent?: (event: GenerateEvent) => void,
): Promise<GenerateResult> {
  onEvent?.({ type: 'stage', stage: 'loading', message: '正在读取当前攻略…' })
  const snapshot = await loadGuideSnapshot(input.guideId)
  if (!snapshot) throw new Error('攻略不存在')

  onEvent?.({ type: 'stage', stage: 'revising', message: '正在按你的要求改稿…' })
  const { guide: llmGuide, usage } = await reviseGuideStream(
    input.instruction,
    snapshot.llmGuide,
    (delta) => {
      if (delta.reasoning) onEvent?.({ type: 'reasoning', text: delta.reasoning })
    },
  )

  onEvent?.({
    type: 'stage',
    stage: 'planned',
    message: `改稿完成，共 ${llmGuide.days.length} 天`,
  })

  const region = llmGuide.region ?? snapshot.meta.region ?? undefined
  const [minLng, minLat, maxLng, maxLat] = bboxForRegion(region)
  const bbox: Bbox = { minLng, minLat, maxLng, maxLat }

  // 跨日衔接修复
  stitchDays(llmGuide.days)

  const flat: { node: LlmNode; dayIndex: number; seq: number }[] = []
  for (const day of llmGuide.days) {
    ;(day.timeline ?? []).forEach((node, index) => {
      flat.push({ node, dayIndex: day.day_index, seq: index })
    })
  }

  const geocodeTotal = flat.filter((item) => needsGeocode(normalizeKind(item.node.kind))).length
  onEvent?.({
    type: 'stage',
    stage: 'geocoding',
    message: `正在解析 ${geocodeTotal} 个节点的坐标…`,
  })

  let doneCount = 0
  const results = await mapLimit(flat, 4, async ({ node, dayIndex, seq }) => {
    const kind = normalizeKind(node.kind)
    const priority = normalizePriority(node.priority)
    // 同名同天的节点直接复用旧坐标，减少检索与抖动
    const reused = needsGeocode(kind) ? snapshot.reuse.get(`${dayIndex}|${node.name}`) : undefined
    const result: { resolved: ResolvedNode; issue?: GenerateIssue } = reused
      ? {
          resolved: {
            ...baseNode(node, dayIndex, seq, kind, priority),
            address: reused.address,
            lng: reused.lng,
            lat: reused.lat,
            lng_gcj: reused.lng_gcj,
            lat_gcj: reused.lat_gcj,
            photos: reused.photos ?? [],
            geocode_status: reused.geocode_status,
            geocode_score: reused.geocode_score,
            geocode_provider: reused.geocode_provider,
            geocode_keyword: reused.geocode_keyword,
          },
        }
      : await resolveNode(node, dayIndex, seq, bbox)

    doneCount += 1
    onEvent?.({
      type: 'poi',
      done: doneCount,
      total: flat.length,
      name: node.name,
      status: result.resolved.geocode_status,
    })
    return result
  })

  // 跨省长串点复核（区域名陌生时 bbox 会退化成全国，这一步兜住）
  await refineOutliers(results, flat, bbox)

  const resolvedNodes = results.map((item) => item.resolved)
  const issues = results
    .map((item) => item.issue)
    .filter((item): item is GenerateIssue => item !== undefined)

  onEvent?.({ type: 'stage', stage: 'persisting', message: '正在保存改稿…' })

  await replaceGuideContent({
    guideId: input.guideId,
    title: llmGuide.title || snapshot.meta.title,
    region: region ?? null,
    summary: llmGuide.summary ?? snapshot.meta.summary,
    prompt: input.instruction,
    llmGuide,
    resolvedNodes,
  })

  onEvent?.({ type: 'stage', stage: 'done', message: '改稿完成' })

  return {
    guideId: input.guideId,
    issues,
    stats: {
      totalNodes: resolvedNodes.length,
      okCount: resolvedNodes.filter((item) => item.geocode_status === 'ok').length,
      suspectCount: resolvedNodes.filter((item) => item.geocode_status === 'suspect').length,
      failedCount: resolvedNodes.filter((item) => item.geocode_status === 'failed').length,
      skippedCount: resolvedNodes.filter((item) => item.geocode_status === 'skipped').length,
      usage,
    },
  }
}
