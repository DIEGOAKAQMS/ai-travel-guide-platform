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

// ---------------------------------------------------------------------------
// 流式生成 / 改稿（SSE）
// ---------------------------------------------------------------------------

export interface StreamHandlers {
  onStage?: (payload: { stage: string; message: string }) => void
  onReasoning?: (payload: { text: string }) => void
  onPoi?: (payload: { done: number; total: number; name: string; status: GeocodeStatus }) => void
  onResult?: (payload: { guide: GuideDto; issues: GenerateIssue[]; stats: GenerateStats }) => void
  onError?: (payload: { message: string }) => void
}

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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件块；最后一段可能不完整，留到下一轮
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const eventLine = block.split('\n').find((line) => line.startsWith('event:'))
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
      if (!eventLine || !dataLine) continue

      const event = eventLine.slice(6).trim()
      let payload: unknown
      try {
        payload = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }

      switch (event) {
        case 'stage':
          handlers.onStage?.(payload as { stage: string; message: string })
          break
        case 'reasoning':
          handlers.onReasoning?.(payload as { text: string })
          break
        case 'poi':
          handlers.onPoi?.(
            payload as { done: number; total: number; name: string; status: GeocodeStatus },
          )
          break
        case 'result':
          handlers.onResult?.(
            payload as { guide: GuideDto; issues: GenerateIssue[]; stats: GenerateStats },
          )
          break
        case 'error':
          handlers.onError?.(payload as { message: string })
          break
        default:
          break
      }
    }
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
