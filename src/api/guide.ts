import type {
  GenerateIssue,
  GenerateStats,
  GeocodeStatus,
  GuideDto,
  GuideSavePayload,
  PoiPhoto,
} from '@/types/guide'

const BASE = '/api/guide'

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
}

/** 统一的错误提取 */
async function unwrap<T>(response: Response): Promise<T> {
  let payload: ApiEnvelope<T>
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new Error(`服务返回异常（HTTP ${response.status}）`)
  }
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
  }
  return payload.data
}

/** 攻略列表项 */
export interface GuideSummary {
  id: string
  title: string
  region: string | null
  summary: string | null
  total_days: number
  status: string
  created_at: string
  /** 软删除（归档）时间；非空表示已归档 */
  archived_at: string | null
  poi_count: number
}

/** 攻略列表；默认不含已归档 */
export async function listGuides(options?: { includeArchived?: boolean }): Promise<GuideSummary[]> {
  const query = options?.includeArchived ? '?includeArchived=1' : ''
  const response = await fetch(`${BASE}${query}`)
  return unwrap<GuideSummary[]>(response)
}

export async function getGuide(id: string): Promise<GuideDto> {
  const response = await fetch(`${BASE}/${id}`)
  return unwrap<GuideDto>(response)
}

export async function deleteGuide(id: string): Promise<void> {
  const response = await fetch(`${BASE}/${id}`, { method: 'DELETE' })
  await unwrap<unknown>(response)
}

/** 修改攻略基础信息（标题 / 区域 / 摘要 / 状态） */
export async function updateGuideMeta(
  id: string,
  payload: { title?: string; region?: string | null; summary?: string | null; status?: string },
): Promise<void> {
  const response = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await unwrap<unknown>(response)
}

/** 软删除：归档 / 恢复 */
export async function setGuideArchived(id: string, archived: boolean): Promise<void> {
  const response = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  })
  await unwrap<unknown>(response)
}

/** 整份保存（编辑器）：返回保存后的完整攻略 */
export async function saveGuide(id: string, payload: GuideSavePayload): Promise<GuideDto> {
  const response = await fetch(`${BASE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return unwrap<GuideDto>(response)
}

/** 计算各天景点间的驾车路线 */
export async function planGuideRoute(
  id: string,
): Promise<{ legCount: number; totalDistanceM: number; skipped: string[] }> {
  const response = await fetch(`${BASE}/${id}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return unwrap<{ legCount: number; totalDistanceM: number; skipped: string[] }>(response)
}

/**
 * 按需补点位实景图（弹窗第一次打开且库里没图时调用）。
 * 服务端拿到图后会写回数据库，后续直接命中缓存。
 */
export async function fetchPoiPhotos(
  poiId: string,
): Promise<{ photos: PoiPhoto[]; cached: boolean }> {
  const response = await fetch(`${BASE}/poi/${poiId}/photos`)
  return unwrap<{ photos: PoiPhoto[]; cached: boolean }>(response)
}

/** 高德地点候选（时间轴手动添加行程时用） */
export interface PlaceCandidateDto {
  name: string
  address: string
  /** 省市区拼接，如「四川省成都市都江堰市」 */
  city: string
  /** WGS84 */
  lng: number
  lat: number
  poiType: string
}

/**
 * 按关键词搜索地点。
 * 走服务端代理，高德 key 不落到浏览器；返回的坐标已是 WGS84。
 */
export async function searchPlace(
  keyword: string,
  options: { city?: string; signal?: AbortSignal } = {},
): Promise<PlaceCandidateDto[]> {
  const params = new URLSearchParams({ keyword })
  if (options.city) params.set('city', options.city)
  const response = await fetch(`${BASE}/place/search?${params.toString()}`, {
    signal: options.signal,
  })
  return unwrap<PlaceCandidateDto[]>(response)
}

// ---------------------------------------------------------------------------
// 流式生成 / 改稿（SSE）
// ---------------------------------------------------------------------------

/** 时间轴重排的改动统计 */
export interface ReplanSummary {
  /** 时间轴上的节点总数 */
  total: number
  /** 被换到其它天的节点数 */
  movedDays: number
  /** 仍在本天、但先后顺序被调整的节点数 */
  reordered: number
  /** 到达时间被改写的节点数 */
  retimed: number
  /** 补上停留时长 / 建议的新节点数 */
  filled: number
}

/** 生成攻略前的澄清问题 */
export interface ClarifyQuestion {
  question: string
  /** 常见选项；用户也可以自己填 */
  options: string[]
  /** 是否可多选（如「想去的景点」），缺省为单选 */
  multiple?: boolean
}

export interface StreamHandlers {
  onStage?: (payload: { stage: string; message: string }) => void
  onReasoning?: (payload: { text: string }) => void
  onPoi?: (payload: { done: number; total: number; name: string; status: GeocodeStatus }) => void
  onResult?: (payload: { guide: GuideDto; issues: GenerateIssue[]; stats: GenerateStats }) => void
  /** 时间轴重排完成（replan/stream 专用） */
  onReplan?: (payload: { guide: GuideDto; summary: ReplanSummary }) => void
  /** 生成前的澄清问题（clarify/stream 专用） */
  onClarify?: (payload: { questions: ClarifyQuestion[] }) => void
  onError?: (payload: { message: string }) => void
}

/**
 * 推理增量的合并间隔（毫秒）。
 *
 * 150ms 约等于每秒 6~7 次界面刷新，人眼看着是连续的，
 * 但相比「一个 chunk 刷一次」能把更新次数砍掉两三个数量级。
 */
const REASONING_FLUSH_MS = 150

export interface GenerateParams {
  prompt: string
  days?: number
  region?: string
}

/**
 * 消费后端 SSE 流。
 *
 * 说明：EventSource 只支持 GET，无法携带请求体，因此这里用 fetch +
 * ReadableStream 手工解析 SSE 帧。服务端已关闭反代缓冲，事件是逐条到达的。
 */
async function consumeSse(response: Response, handlers: StreamHandlers): Promise<void> {
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const payload = (await response.json()) as ApiEnvelope<unknown>
      if (payload.error) message = payload.error
    } catch {
      // 忽略解析失败，使用默认文案
    }
    throw new Error(message)
  }
  if (!response.body) {
    throw new Error('当前环境不支持流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  /**
   * 推理增量先攒着，按时间合并后再交给上层。
   *
   * 一次生成会吐出上万个 reasoning 事件，如果逐个回调，
   * 上层「拼字符串 → 触发 Vue 响应式 → 重渲染」也要跟着跑上万次，
   * 主线程会被彻底拖住（表现就是界面卡死，结果出来了也渲染不出来）。
   */
  let reasoningPending = ''
  let reasoningTimer: number | null = null

  const flushReasoning = (): void => {
    if (reasoningTimer !== null) {
      window.clearTimeout(reasoningTimer)
      reasoningTimer = null
    }
    if (!reasoningPending) return
    const text = reasoningPending
    reasoningPending = ''
    handlers.onReasoning?.({ text })
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件块；最后一段可能不完整，留到下一轮
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        // 一行扫完，不再 split 两次去 find
        let event = ''
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data = line.slice(5).trim()
        }
        if (!event || !data) continue

        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        switch (event) {
          case 'stage':
            handlers.onStage?.(payload as { stage: string; message: string })
            break
          case 'reasoning':
            reasoningPending += (payload as { text: string }).text
            if (reasoningTimer === null) {
              reasoningTimer = window.setTimeout(flushReasoning, REASONING_FLUSH_MS)
            }
            break
          case 'poi':
            handlers.onPoi?.(
              payload as { done: number; total: number; name: string; status: GeocodeStatus },
            )
            break
          case 'result':
            flushReasoning()
            handlers.onResult?.(
              payload as { guide: GuideDto; issues: GenerateIssue[]; stats: GenerateStats },
            )
            break
          case 'replan':
            flushReasoning()
            handlers.onReplan?.(payload as { guide: GuideDto; summary: ReplanSummary })
            break
          case 'clarify':
            flushReasoning()
            handlers.onClarify?.(payload as { questions: ClarifyQuestion[] })
            break
          case 'error':
            flushReasoning()
            handlers.onError?.(payload as { message: string })
            break
          default:
            break
        }
      }
    }
  } finally {
    // 正常结束或被中断，尾巴都要吐出去，不能丢
    flushReasoning()
  }
}

/** 一句话生成攻略（SSE 流式） */
export async function generateGuideStream(
  params: GenerateParams,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${BASE}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  })
  await consumeSse(response, handlers)
}

/** AI 改稿：在当前攻略基础上按指令重写（SSE 流式，原地更新） */
export async function reviseGuideStream(
  id: string,
  instruction: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${BASE}/${id}/revise/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction }),
    signal,
  })
  await consumeSse(response, handlers)
}

/**
 * 生成攻略前先让 AI 反问（SSE 流式）。
 *
 * 只产出问题列表（含常见选项），由用户答完后拼进 prompt 再调 generateGuideStream。
 */
export async function clarifyGuideStream(
  prompt: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${BASE}/clarify/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  })
  await consumeSse(response, handlers)
}

/**
 * AI 重排时间轴（SSE 流式，原地更新）。
 *
 * 只重新安排节点的**顺序 / 所属天 / 到达时间**，不会新增或删除节点，
 * 服务端用节点 id 做锚点，保证时间轴内容不被改写。
 *
 * `affectedDays` 限定只重排哪几天（时间轴编辑只改了某一天时用），
 * 其余天原样保留；不传则重排全部天。用户新加、没有停留时长的节点
 * 会被服务端标出来，让模型顺手补上游玩时长与建议。
 */
export async function replanGuideStream(
  id: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  affectedDays?: number[],
): Promise<void> {
  const response = await fetch(`${BASE}/${id}/replan/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ affectedDays }),
    signal,
  })
  await consumeSse(response, handlers)
}
