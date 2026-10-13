import { Router, type NextFunction, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { query, queryOne, withTransaction } from '../db/pool'
import { planDriving, searchPoi, type PlaceCandidate } from '../services/amap'
import { clarifyGuideStream } from '../services/llm'
import { generateGuide, replanGuide, reviseGuide, searchKeywords, shortCity } from '../services/guide'
import { wgs84ToGcj02 } from '../utils/coord'
import { computeArrivalTimes, type ScheduleLeg, type ScheduleNode } from '../utils/schedule'
import type { GuideDayDto, GuideDto, GuidePoiDto, GuideRouteDto, PoiPhoto } from '../types'

export const guideRouter = Router()

/** express 4 不会自动捕获 async 异常，统一包一层 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}

/** 打开一条 SSE 通道，返回事件发送器（内部自行处理「客户端已断开」） */
function openSseChannel(res: Response): { send: (event: string, data: unknown) => void } {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 关闭 Nginx 等反代的缓冲，否则事件会被攒着一次性吐出
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // 注意：必须监听 res 而不是 req。
  // Node 16+ 起 req 的 'close' 会在「请求体读取完毕」时触发（而非客户端断开），
  // 若用它做标志位，首个事件之后的所有 write 都会被静默丢弃。
  let closed = false
  res.on('close', () => {
    closed = true
  })

  return {
    send: (event, data) => {
      if (closed || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** jsonb 数组字段容错：统一成干净的字符串数组 */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
}

/** jsonb 图片字段容错：只保留能直接给 <img> 用的 http(s) URL */
function toPhotoList(value: unknown): PoiPhoto[] {
  if (!Array.isArray(value)) return []
  const photos: PoiPhoto[] = []
  for (const item of value) {
    const record = item as { title?: unknown; url?: unknown }
    const url = typeof record?.url === 'string' ? record.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) continue
    photos.push({ title: typeof record.title === 'string' ? record.title : '', url })
  }
  return photos
}

// ---------------------------------------------------------------------------
// 入参校验
//
// 非法入参（非 uuid 的 id、非字符串的 prompt、超长的关键词…）必须在这里被拦下来，
// 否则它会一路走到 pg / 高德，最后变成一个 500 —— 前端只看到「服务器内部错误」，
// 既定位不到原因，也分不清是「你传错了」还是「服务挂了」。
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 需求描述 / 修改要求的长度上限 */
const MAX_PROMPT_LEN = 2000
/** 地点关键词的长度上限（高德也放不下更长的词） */
const MAX_KEYWORD_LEN = 60

/**
 * 路径参数校验中间件：不是合法 uuid 直接 400。
 *
 * 直接把 id 丢给 pg 会抛 22P02（invalid input syntax for type uuid），
 * 经错误中间件变成 500，看起来像服务出了问题。
 */
function requireUuidParam(...names: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const name of names) {
      if (!UUID_RE.test(req.params[name] ?? '')) {
        res.status(400).json({ ok: false, error: `${name} 不是合法的 UUID` })
        return
      }
    }
    next()
  }
}

/**
 * 读取必填文本参数；不合法时已写好响应并返回 null。
 *
 * 只接受真正的字符串：`?keyword=a&keyword=b` 会被解析成数组（过去 String() 硬转
 * 会得到 "a,b" 这种脏值），而 prompt 传数字会在 .trim() 上直接抛 TypeError。
 */
function requireText(
  res: Response,
  value: unknown,
  name: string,
  maxLen = MAX_PROMPT_LEN,
): string | null {
  if (typeof value !== 'string') {
    res.status(400).json({ ok: false, error: `${name} 必须是字符串` })
    return null
  }
  const text = value.trim()
  if (!text) {
    res.status(400).json({ ok: false, error: `${name} 不能为空` })
    return null
  }
  if (text.length > maxLen) {
    res.status(400).json({ ok: false, error: `${name} 过长（最多 ${maxLen} 字）` })
    return null
  }
  return text
}

/** 读取可选文本参数：缺省返回 undefined；传了但不是合法文本则返回 null（已响应 400） */
function optionalText(
  res: Response,
  value: unknown,
  name: string,
  maxLen = MAX_PROMPT_LEN,
): string | undefined | null {
  if (value === undefined || value === null) return undefined
  return requireText(res, value, name, maxLen)
}

/** 生成类接口（生成 / 生成流）的公共入参校验；不合法时已响应 400 并返回 null */
function readGenerateParams(
  req: Request,
  res: Response,
): { prompt: string; days?: number; region?: string } | null {
  const body = (req.body ?? {}) as { prompt?: unknown; days?: unknown; region?: unknown }

  const prompt = requireText(res, body.prompt, 'prompt')
  if (!prompt) return null

  let days: number | undefined
  if (body.days !== undefined && body.days !== null && body.days !== '') {
    const parsed = Number(body.days)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      res.status(400).json({ ok: false, error: 'days 必须是 1~60 之间的天数' })
      return null
    }
    days = Math.round(parsed)
  }

  const region = optionalText(res, body.region, 'region', MAX_KEYWORD_LEN)
  if (region === null) return null

  return { prompt, days, region: region || undefined }
}

// ---------------------------------------------------------------------------
// 整份保存（PUT /api/guide/:id）用到的载荷结构
// ---------------------------------------------------------------------------

interface SavePoiPayload {
  id?: string | null
  name?: string
  kind?: string
  priority?: string
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
  /** 坐标是否由人工指定（地图拾取 / 手工输入）→ 标记 manual + verified */
  manual?: boolean
}

interface SaveDayPayload {
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
  pois?: SavePoiPayload[]
}

/**
 * 校验整份保存的 days 载荷结构；返回错误文案，null 表示通过。
 *
 * 关键的一条：**days 为空数组要拒绝**。PUT 的语义是「整份覆盖」，
 * 传空数组会把这份攻略的天、节点、路线全部删光（total_days 归零），
 * 而前端只要有一次渲染出空列表（草稿没加载出来 / 切换攻略时残留旧草稿），
 * 一保存就是一次不可逆的清空。
 */
function validateDaysPayload(days: unknown): string | null {
  if (!Array.isArray(days)) return 'days 必须是数组'
  if (days.length === 0) return 'days 不能为空：整份保存至少要保留一天'

  for (const day of days) {
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      return 'days 的每一项都必须是对象'
    }
    const record = day as SaveDayPayload
    if (!Number.isFinite(Number(record.day_index))) return 'days[].day_index 必须是数字'
    if (record.pois !== undefined && !Array.isArray(record.pois)) {
      return 'days[].pois 必须是数组'
    }
  }
  return null
}

/** 按 id 更新、不存在则插入一天，返回其 id */
async function upsertDay(
  client: PoolClient,
  guideId: string,
  day: SaveDayPayload,
): Promise<string> {
  const values = [
    day.day_index,
    day.title?.trim() || null,
    day.summary?.trim() || null,
    day.route_text?.trim() || null,
    day.stay_text?.trim() || null,
    day.highlights?.trim() || null,
    day.cautions?.trim() || null,
    num(day.drive_km),
    day.drive_hours?.trim() || null,
    num(day.sleep_altitude_m),
    num(day.max_altitude_m),
    JSON.stringify(day.notes ?? []),
  ]

  if (day.id) {
    const updated = await client.query<{ id: string }>(
      `UPDATE guide_day SET day_index=$3, title=$4, summary=$5, route_text=$6, stay_text=$7,
              highlights=$8, cautions=$9, drive_km=$10, drive_hours=$11,
              sleep_altitude_m=$12, max_altitude_m=$13, notes=$14
        WHERE id=$1 AND guide_id=$2 RETURNING id`,
      [day.id, guideId, ...values],
    )
    if (updated.rows.length > 0) return updated.rows[0].id
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO guide_day (guide_id, day_index, title, summary, route_text, stay_text,
            highlights, cautions, drive_km, drive_hours, sleep_altitude_m, max_altitude_m, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [guideId, ...values],
  )
  return inserted.rows[0].id
}

/** 按 id 更新、不存在则插入一个节点；坐标变更时自动补 GCJ-02 备用坐标 */
async function upsertPoi(
  client: PoolClient,
  guideId: string,
  dayId: string,
  seq: number,
  poi: SavePoiPayload,
): Promise<void> {
  const kind = poi.kind?.trim() || 'spot'
  const priority = poi.priority?.trim() || 'normal'
  const lng = num(poi.lng)
  const lat = num(poi.lat)

  let lngGcj: number | null = null
  let latGcj: number | null = null
  if (lng !== null && lat !== null) {
    const [gLng, gLat] = wgs84ToGcj02(lng, lat)
    lngGcj = Number(gLng.toFixed(6))
    latGcj = Number(gLat.toFixed(6))
  }

  const manual = poi.manual === true
  const values = [
    dayId,
    seq,
    poi.name?.trim() || '未命名节点',
    kind,
    priority,
    poi.city?.trim() || null,
    poi.address?.trim() || null,
    lng,
    lat,
    lngGcj,
    latGcj,
    poi.arrive_time?.trim() || null,
    num(poi.stay_minutes),
    num(poi.leg_km),
    poi.notes?.trim() || null,
    poi.warnings?.trim() || null,
    poi.tips?.trim() || null,
  ]

  if (poi.id) {
    const manualSets = manual
      ? ", geocode_status='manual', verified=true, geocode_provider='manual'"
      : ''
    const updated = await client.query(
      `UPDATE guide_poi SET day_id=$3, seq=$4, name=$5, kind=$6, priority=$7, city=$8, address=$9,
              lng=$10, lat=$11, lng_gcj=$12, lat_gcj=$13, arrive_time=$14, stay_minutes=$15,
              leg_km=$16, notes=$17, warnings=$18, tips=$19${manualSets}
        WHERE id=$1 AND guide_id=$2 RETURNING id`,
      [poi.id, guideId, ...values],
    )
    if (updated.rows.length > 0) return
  }

  const status = manual
    ? 'manual'
    : kind === 'drive' || kind === 'rest'
      ? 'skipped'
      : lng !== null && lat !== null
        ? 'ok'
        : 'failed'

  await client.query(
    `INSERT INTO guide_poi (guide_id, day_id, seq, name, kind, priority, city, address,
            lng, lat, lng_gcj, lat_gcj, arrive_time, stay_minutes, leg_km,
            notes, warnings, tips, geocode_status, verified, geocode_provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [guideId, ...values, status, manual, manual ? 'manual' : null],
  )
}

// ---------------------------------------------------------------------------
// POST /api/guide/generate —— 一句话生成攻略
// ---------------------------------------------------------------------------
guideRouter.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const params = readGenerateParams(req, res)
    if (!params) return

    const started = Date.now()
    const result = await generateGuide(params)

    const guide = await loadGuide(result.guideId)

    res.json({
      ok: true,
      data: guide,
      issues: result.issues,
      stats: { ...result.stats, elapsedMs: Date.now() - started },
    })
  }),
)

// ---------------------------------------------------------------------------
// POST /api/guide/generate/stream —— 一句话生成攻略（SSE 流式）
//
// 事件类型：
//   stage     { stage, message }              阶段变化
//   reasoning { text }                        模型思考增量
//   poi       { done, total, name, status }   单点落点完成
//   result    { guide, issues, stats }        最终结果
//   error     { message }                     失败
// ---------------------------------------------------------------------------
guideRouter.post(
  '/generate/stream',
  asyncHandler(async (req, res) => {
    const params = readGenerateParams(req, res)
    if (!params) return

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // 关闭 Nginx 等反代的缓冲，否则事件会被攒着一次性吐出
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // 注意：必须监听 res 而不是 req。
    // Node 16+ 起 req 的 'close' 会在「请求体读取完毕」时触发（而非客户端断开），
    // 若用它做标志位，首个事件之后的所有 write 都会被静默丢弃。
    let closed = false
    res.on('close', () => {
      closed = true
    })

    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const started = Date.now()

    try {
      const result = await generateGuide(
        params,
        (event) => {
          if (event.type === 'reasoning') {
            send('reasoning', { text: event.text })
          } else if (event.type === 'stage') {
            send('stage', { stage: event.stage, message: event.message })
          } else {
            send('poi', event)
          }
        },
      )

      const guide = await loadGuide(result.guideId)
      send('result', {
        guide,
        issues: result.issues,
        stats: { ...result.stats, elapsedMs: Date.now() - started },
      })
    } catch (error) {
      console.error('[generate/stream] 失败：', error)
      send('error', { message: (error as Error).message || '生成失败' })
    } finally {
      if (!closed) res.end()
    }
  }),
)

// ---------------------------------------------------------------------------
// POST /api/guide/clarify/stream —— 生成攻略前的澄清提问（SSE 流式）
//
// 用户给出初步想法后，先让模型反问几个关键问题；用户答完再带着答案去生成，
// 避免一上来就凭猜测排一整条行程。
//
// 事件类型：
//   stage     { stage, message }
//   reasoning { text }
//   clarify   { questions }   澄清问题列表
//   error     { message }
// ---------------------------------------------------------------------------
guideRouter.post(
  '/clarify/stream',
  asyncHandler(async (req, res) => {
    // 校验必须放在开 SSE 通道之前：通道一开响应头就发出去了，
    // 再想回一个 400 的 JSON 就晚了。
    const prompt = requireText(res, (req.body as { prompt?: unknown })?.prompt, 'prompt')
    if (!prompt) return

    const { send } = openSseChannel(res)

    try {
      send('stage', { stage: 'clarifying', message: '正在梳理还需要确认的信息…' })

      const { plan } = await clarifyGuideStream(prompt, (delta) => {
        if (delta.reasoning) send('reasoning', { text: delta.reasoning })
      })

      send('clarify', { questions: plan.questions })
    } catch (error) {
      console.error('[clarify/stream] 失败：', error)
      send('error', { message: (error as Error).message || '提问失败' })
    } finally {
      if (!res.writableEnded) res.end()
    }
  }),
)

// ---------------------------------------------------------------------------
// GET /api/guide —— 攻略列表
// ---------------------------------------------------------------------------
guideRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true'
    const rows = await query<{
      id: string
      title: string
      region: string | null
      summary: string | null
      total_days: number
      status: string
      created_at: string
      archived_at: string | null
      poi_count: string
    }>(
      `SELECT g.id, g.title, g.region, g.summary, g.total_days, g.status,
              g.created_at, g.archived_at,
              COUNT(p.id)::text AS poi_count
         FROM guide g
         LEFT JOIN guide_poi p ON p.guide_id = g.id
        ${includeArchived ? '' : 'WHERE g.archived_at IS NULL'}
        GROUP BY g.id
        ORDER BY g.created_at DESC
        LIMIT 200`,
    )

    res.json({
      ok: true,
      data: rows.map((row) => ({ ...row, poi_count: Number(row.poi_count) })),
    })
  }),
)

// ---------------------------------------------------------------------------
// GET /api/guide/place/search —— 高德 POI 搜索（时间轴手动添加行程用）
//
// 返回 WGS84 坐标：前端确认某个候选后直接带坐标提交保存。
// 注意：必须注册在 GET /:id 之前，`/place/search` 是两段路径虽不会撞上单段
// 的 /:id，但放在前面可读性更好、也避免后续新增路由时踩坑。
// ---------------------------------------------------------------------------
guideRouter.get(
  '/place/search',
  asyncHandler(async (req, res) => {
    const keyword = requireText(res, req.query.keyword, 'keyword', MAX_KEYWORD_LEN)
    if (!keyword) return

    const city = optionalText(res, req.query.city, 'city', MAX_KEYWORD_LEN)
    if (city === null) return

    const candidates = await searchPoi(keyword, {
      city: city || undefined,
      limit: 10,
    })

    res.json({
      ok: true,
      data: candidates.map((item) => ({
        name: item.name,
        address: item.address ?? '',
        city: [item.province, item.city, item.district].filter(Boolean).join(''),
        lng: item.lng,
        lat: item.lat,
        poiType: item.poiType ?? '',
      })),
    })
  }),
)

// ---------------------------------------------------------------------------
// GET /api/guide/:id —— 攻略详情
// ---------------------------------------------------------------------------
guideRouter.get(
  '/:id',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guide = await loadGuide(req.params.id)
    if (!guide) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }
    res.json({ ok: true, data: guide })
  }),
)

// ---------------------------------------------------------------------------
// PATCH /api/guide/:id —— 修改攻略基础信息 / 归档 / 恢复
// ---------------------------------------------------------------------------
guideRouter.patch(
  '/:id',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as {
      title?: string
      region?: string | null
      summary?: string | null
      status?: string
      archived?: boolean
    }

    const sets: string[] = []
    const params: unknown[] = []

    if (typeof body.title === 'string' && body.title.trim()) {
      params.push(body.title.trim())
      sets.push(`title = $${params.length}`)
    }
    if (body.region !== undefined) {
      params.push(typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null)
      sets.push(`region = $${params.length}`)
    }
    if (body.summary !== undefined) {
      params.push(
        typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : null,
      )
      sets.push(`summary = $${params.length}`)
    }
    if (typeof body.status === 'string' && body.status.trim()) {
      params.push(body.status.trim())
      sets.push(`status = $${params.length}`)
    }
    // 软删除：归档 / 恢复
    if (typeof body.archived === 'boolean') {
      sets.push(body.archived ? 'archived_at = now()' : 'archived_at = NULL')
    }

    if (sets.length === 0) {
      res.status(400).json({ ok: false, error: '没有可更新的字段' })
      return
    }

    params.push(req.params.id)
    const updated = await queryOne<{ id: string }>(
      `UPDATE guide SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    )
    if (!updated) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }
    res.json({ ok: true, data: { id: updated.id } })
  }),
)

// ---------------------------------------------------------------------------
// PUT /api/guide/:id —— 整份保存（编辑器用）
//
// 按 id upsert 天与节点：已有 id 的原地更新（保留其下路线段），
// 载荷中缺失的天 / 节点会被删除（级联删除对应路线段）。
//
// 注意这是「整份覆盖」语义：**空 days 一律拒绝**，
// 否则一次误提交（草稿未加载 / 残留了别的攻略的草稿）就会把整份攻略清空。
// ---------------------------------------------------------------------------
guideRouter.put(
  '/:id',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guideId = req.params.id
    const body = (req.body ?? {}) as {
      title?: string
      region?: string | null
      summary?: string | null
      days?: SaveDayPayload[]
    }

    const daysError = validateDaysPayload(body.days)
    if (daysError) {
      res.status(400).json({ ok: false, error: daysError })
      return
    }

    const exists = await queryOne<{ id: string }>('SELECT id FROM guide WHERE id = $1', [guideId])
    if (!exists) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }

    const days = body.days as SaveDayPayload[]

    await withTransaction(async (client) => {
      // 1) 主表基础信息
      await client.query(
        `UPDATE guide
            SET title = COALESCE($2, title), region = $3, summary = $4, total_days = $5
          WHERE id = $1`,
        [
          guideId,
          typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
          typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null,
          typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : null,
          days.length,
        ],
      )

      // 2) 删除已移除的天（级联其下点位与路线）
      const keepDayIds = days.map((day) => day.id).filter((id): id is string => Boolean(id))
      await client.query('DELETE FROM guide_day WHERE guide_id = $1 AND id <> ALL($2::uuid[])', [
        guideId,
        keepDayIds,
      ])

      // 2.5) 天顺序可能被重排：先把现有 day_index 整体挪到高位，
      //      否则逐条更新时会撞上 UNIQUE(guide_id, day_index)
      await client.query('UPDATE guide_day SET day_index = day_index + 100000 WHERE guide_id = $1', [
        guideId,
      ])

      // 3) 删除已移除的点位
      const keepPoiIds = days
        .flatMap((day) => day.pois ?? [])
        .map((poi) => poi.id)
        .filter((id): id is string => Boolean(id))
      await client.query('DELETE FROM guide_poi WHERE guide_id = $1 AND id <> ALL($2::uuid[])', [
        guideId,
        keepPoiIds,
      ])

      // 4) 逐天、逐节点 upsert（seq 以数组顺序为准）
      for (const day of days) {
        const dayId = await upsertDay(client, guideId, day)
        let seq = 0
        for (const poi of day.pois ?? []) {
          await upsertPoi(client, guideId, dayId, seq, poi)
          seq += 1
        }
      }
    })

    const guide = await loadGuide(guideId)
    if (!guide) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }
    res.json({ ok: true, data: guide })
  }),
)

// ---------------------------------------------------------------------------
// DELETE /api/guide/:id —— 永久删除攻略
//
// guide_day / guide_poi / guide_route 都以 ON DELETE CASCADE 挂在 guide 上，
// 删除主表记录即可同步清空这三张表里对应的数据。
// 注意：必须返回 data 字段，前端 unwrap() 要求 data 存在。
// ---------------------------------------------------------------------------
guideRouter.delete(
  '/:id',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const deleted = await queryOne<{ id: string }>(
      'DELETE FROM guide WHERE id = $1 RETURNING id',
      [req.params.id],
    )

    if (!deleted) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }
    res.json({ ok: true, data: { id: deleted.id } })
  }),
)

// ---------------------------------------------------------------------------
// PATCH /api/guide/poi/:poiId —— 人工校正点位
// ---------------------------------------------------------------------------
guideRouter.patch(
  '/poi/:poiId',
  requireUuidParam('poiId'),
  asyncHandler(async (req, res) => {
    const { lng, lat, day_id, seq } = (req.body ?? {}) as {
      lng?: number
      lat?: number
      day_id?: string
      seq?: number
    }

    // day_id 也是 uuid 列，非法值同样会在 pg 里炸成 500
    if (day_id !== undefined && !UUID_RE.test(day_id)) {
      res.status(400).json({ ok: false, error: 'day_id 不是合法的 UUID' })
      return
    }

    const sets: string[] = []
    const params: unknown[] = []

    if (typeof lng === 'number' && typeof lat === 'number') {
      // 交给触发器同步 geom；同时更新 GCJ-02 备用坐标
      const { wgs84ToGcj02 } = await import('../utils/coord')
      const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
      params.push(lng, lat, gcjLng, gcjLat)
      sets.push(
        `lng = $${params.length - 3}, lat = $${params.length - 2}, ` +
          `lng_gcj = $${params.length - 1}, lat_gcj = $${params.length}`,
        "geocode_status = 'manual'",
        'verified = true',
        "geocode_provider = 'manual'",
      )
    }
    if (day_id !== undefined) {
      params.push(day_id)
      sets.push(`day_id = $${params.length}`)
    }
    if (typeof seq === 'number') {
      params.push(seq)
      sets.push(`seq = $${params.length}`)
    }

    if (sets.length === 0) {
      res.status(400).json({ ok: false, error: '没有可更新的字段' })
      return
    }

    params.push(req.params.poiId)
    const updated = await queryOne<{ id: string }>(
      `UPDATE guide_poi SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    )

    if (!updated) {
      res.status(404).json({ ok: false, error: '点位不存在' })
      return
    }
    res.json({ ok: true, data: { id: updated.id } })
  }),
)

/**
 * 路线算出来后，按「上一站到达时间 + 停留时长 + 实际驾车耗时」重排每天的到达时间。
 *
 * 背景：arrive_time 来自模型估算，与 stay_minutes、高德实际耗时对不上，
 * 时间轴上会出现「A → B 的间隔 ≠ A 游玩时长 + 路上耗时」。这里用真实路线
 * 把整条时间轴对齐，写回后时间轴 / 弹窗 / 导出手册看到的是同一套时间。
 */
async function rescheduleArrivalTimes(guideId: string): Promise<void> {
  const poiRows = await query<ScheduleNode & { day_id: string | null }>(
    `SELECT p.id, p.day_id, p.seq, p.arrive_time, p.stay_minutes
       FROM guide_poi p
       JOIN guide_day d ON d.id = p.day_id
      WHERE p.guide_id = $1
      ORDER BY d.day_index, p.seq`,
    [guideId],
  )
  if (poiRows.length === 0) return

  const legRows = await query<ScheduleLeg>(
    `SELECT from_poi_id, to_poi_id, duration_s
       FROM guide_route
      WHERE guide_id = $1 AND transfer = false`,
    [guideId],
  )

  const nodesByDay = new Map<string, ScheduleNode[]>()
  for (const poi of poiRows) {
    if (!poi.day_id) continue
    const list = nodesByDay.get(poi.day_id)
    const node: ScheduleNode = {
      id: poi.id,
      seq: poi.seq,
      arrive_time: poi.arrive_time,
      stay_minutes: poi.stay_minutes,
    }
    if (list) list.push(node)
    else nodesByDay.set(poi.day_id, [node])
  }

  const patches = [...nodesByDay.values()].flatMap((nodes) => computeArrivalTimes(nodes, legRows))
  if (patches.length === 0) return

  await withTransaction(async (client) => {
    for (const patch of patches) {
      await client.query('UPDATE guide_poi SET arrive_time = $1 WHERE id = $2', [
        patch.arrive_time,
        patch.id,
      ])
    }
  })
}

/**
 * 依次用关键词去高德找实景图。
 *
 * 优先取「名字和关键词对得上」的那条 POI 的图（避免拿到同名酒店 / 停车场的图），
 * 退而取第一条有图的；都没有就换下一个关键词。
 */
async function findPoiPhotos(keywords: string[], city?: string): Promise<PoiPhoto[]> {
  for (const keyword of keywords) {
    const candidates = await searchPoi(keyword, { city, limit: 5 }).catch(() => [])
    const withPhotos = candidates.filter((item) => item.photos.length > 0)
    if (withPhotos.length === 0) continue

    let best = withPhotos[0]
    let bestScore = photoScore(best, keyword)
    for (const item of withPhotos.slice(1)) {
      const score = photoScore(item, keyword)
      if (score > bestScore) {
        best = item
        bestScore = score
      }
    }
    return best.photos.slice(0, 4)
  }
  return []
}

/**
 * 给候选 POI 打个「拿它当配图合不合适」的分。
 *
 * 同一个关键词往往搜出一串同名的酒店、停车场、管理局，直接取第一条就会给景点配上
 * 一张旅馆门脸；名字对得上的、以及风景名胜 / 地名 / 餐饮类的排前面，公司机关排后面。
 */
function photoScore(item: PlaceCandidate, keyword: string): number {
  let score = 0
  if (item.name === keyword) score += 4
  else if (item.name.includes(keyword) || keyword.includes(item.name)) score += 3
  const type = item.poiType ?? ''
  if (/风景名胜|地名地址信息|餐饮服务|体育休闲|文化场馆/.test(type)) score += 2
  if (/住宿服务|公司企业|政府机构|金融保险|生活服务/.test(type)) score -= 3
  // 停车场 / 售票处这类「附属设施」图不是风景照
  if (/停车场|售票处|管理局|收费站|派出所|变电站/.test(item.name)) score -= 2
  return score
}

// ---------------------------------------------------------------------------
// GET /api/guide/poi/:poiId/photos —— 按需补实景图
//
// 生成攻略落点时已经顺手把高德 POI 的实景图存进 guide_poi.photos；
// 老攻略（或走结构化地理编码落点的节点）没有图，这里在第一次打开弹窗时补一次并写回，
// 之后直接命中库里缓存，不再打高德。
// ---------------------------------------------------------------------------
guideRouter.get(
  '/poi/:poiId/photos',
  requireUuidParam('poiId'),
  asyncHandler(async (req, res) => {
    const poi = await queryOne<{
      id: string
      name: string
      kind: string
      city: string | null
      photo_keywords: unknown
      photos: unknown
    }>('SELECT id, name, kind, city, photo_keywords, photos FROM guide_poi WHERE id = $1', [
      req.params.poiId,
    ])
    if (!poi) {
      res.status(404).json({ ok: false, error: '点位不存在' })
      return
    }

    const cached = toPhotoList(poi.photos)
    if (cached.length > 0) {
      res.json({ ok: true, data: { photos: cached, cached: true } })
      return
    }

    const city = shortCity(poi.city ?? undefined)
    // 先用节点名（就是那个真实 POI），再用 LLM 给的配图关键词兜底
    const keywords = [...searchKeywords(poi.name), ...toStringList(poi.photo_keywords)].slice(0, 4)
    const photos = await findPoiPhotos(keywords, city)
    if (photos.length > 0) {
      await query('UPDATE guide_poi SET photos = $1 WHERE id = $2', [
        JSON.stringify(photos),
        poi.id,
      ])
    }

    res.json({ ok: true, data: { photos, cached: false } })
  }),
)

// ---------------------------------------------------------------------------
// POST /api/guide/:id/route —— 计算各天景点间的驾车路线
// ---------------------------------------------------------------------------
guideRouter.post(
  '/:id/route',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guideId = req.params.id
    const strategy = Number((req.body as { strategy?: number })?.strategy ?? 0)

    const days = await query<{ id: string; day_index: number }>(
      'SELECT id, day_index FROM guide_day WHERE guide_id = $1 ORDER BY day_index',
      [guideId],
    )
    if (days.length === 0) {
      res.status(404).json({ ok: false, error: '攻略不存在或没有行程天' })
      return
    }

    const pois = await query<{
      id: string
      day_id: string | null
      seq: number
      name: string
      kind: string
      lng: number | null
      lat: number | null
    }>(
      `SELECT id, day_id, seq, name, kind, lng, lat
         FROM guide_poi
        WHERE guide_id = $1 AND lng IS NOT NULL AND lat IS NOT NULL
        ORDER BY seq`,
      [guideId],
    )

    const skipped: string[] = []
    const legs: {
      dayId: string
      dayIndex: number
      fromId: string
      toId: string
      seq: number
      /** 跨天转移段（上一日终点 → 次日起点） */
      transfer: boolean
      path: [number, number][]
      distanceM: number
      durationS: number
    }[] = []

    /** 规划一段路，并把结果压入 legs；失败只记录不中断整条行程 */
    async function planLeg(
      dayId: string,
      dayIndex: number,
      seq: number,
      transfer: boolean,
      from: { id: string; name: string; lng: number | null; lat: number | null },
      to: { id: string; name: string; lng: number | null; lat: number | null },
    ): Promise<void> {
      try {
        const result = await planDriving(
          [from.lng as number, from.lat as number],
          [to.lng as number, to.lat as number],
          { strategy },
        )
        legs.push({
          dayId,
          dayIndex,
          fromId: from.id,
          toId: to.id,
          seq,
          transfer,
          path: result.path,
          distanceM: result.distanceM,
          durationS: result.durationS,
        })
      } catch (error) {
        skipped.push(`${from.name} → ${to.name}：${(error as Error).message}`)
      }
    }

    for (const day of days) {
      const dayPois = pois.filter((poi) => poi.day_id === day.id)
      for (let i = 0; i < dayPois.length - 1; i += 1) {
        await planLeg(day.id, day.day_index, i, false, dayPois[i], dayPois[i + 1])
      }
    }

    // 跨天转移段：把「前一天最后一个落点」接到「次日第一个落点」，
    // 否则地图上的折线会在天与天之间断开，看起来行程不连续。
    //
    // 例外：如果次日第一个落点就是「XX出发」这类起点节点（drive / rest），
    // 说明当天首段导航已经从它开始，再补一条跨天段只会得到一条零长的重复线，故跳过。
    for (let i = 1; i < days.length; i += 1) {
      const prevDay = days[i - 1]
      const day = days[i]
      const prevList = pois.filter((poi) => poi.day_id === prevDay.id)
      const list = pois.filter((poi) => poi.day_id === day.id)
      const from = prevList[prevList.length - 1]
      const to = list[0]
      if (!from || !to) continue
      if (to.kind === 'drive' || to.kind === 'rest') continue
      await planLeg(day.id, day.day_index, 0, true, from, to)
    }

    await withTransaction(async (client) => {
      await client.query('DELETE FROM guide_route WHERE guide_id = $1', [guideId])

      for (const leg of legs) {
        const wkt =
          leg.path.length >= 2
            ? `LINESTRING(${leg.path.map(([lng, lat]) => `${lng} ${lat}`).join(',')})`
            : null
        await client.query(
          `INSERT INTO guide_route (
             guide_id, day_id, from_poi_id, to_poi_id, seq, transfer,
             geom, path, distance_m, duration_s, provider
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'amap')`,
          [
            guideId,
            leg.dayId,
            leg.fromId,
            leg.toId,
            leg.seq,
            leg.transfer,
            wkt,
            JSON.stringify(leg.path),
            leg.distanceM,
            leg.durationS,
          ],
        )
      }

      // 用真实里程回填「距上一节点里程」（时间轴上那个里程胶囊）。
      // 重排 / 增删节点后模型当初估的值已失效，这里统一以高德结果为准。
      //
      // 跨天转移段也要一起回填：每天第一个节点没有再往前的段内路段，
      // 它的「距上一节点」就是前一天终点开过来的那一段；
      // 漏掉它的话，重排时刚被置空的 leg_km 会一直空着（里程胶囊消失）。
      const coveredPoiIds = new Set(legs.map((leg) => leg.toId))
      for (const leg of legs) {
        await client.query('UPDATE guide_poi SET leg_km = $1 WHERE id = $2', [
          Number((leg.distanceM / 1000).toFixed(1)),
          leg.toId,
        ])
      }

      // 每天第一个节点可能一段路都不「到达」它：当天首段导航就是从它开始的，
      // 跨天转移段（见上）在这种情况下会被刻意跳过。按约定它的 leg_km 是 0，
      // 得显式写回去 —— 否则它会停在重排时置空的 NULL 上，看起来就是里程数据丢了。
      for (const day of days) {
        const firstPoi = pois.find((poi) => poi.day_id === day.id)
        if (!firstPoi || coveredPoiIds.has(firstPoi.id)) continue
        await client.query('UPDATE guide_poi SET leg_km = 0 WHERE id = $1', [firstPoi.id])
      }

      // 回填每天的里程与耗时（跨天转移段不计入当日里程）
      for (const day of days) {
        const dayLegs = legs.filter((leg) => leg.dayId === day.id && !leg.transfer)
        if (dayLegs.length === 0) continue
        const totalDistance = dayLegs.reduce((sum, leg) => sum + leg.distanceM, 0)
        const totalDuration = dayLegs.reduce((sum, leg) => sum + leg.durationS, 0)
        await client.query(
          `UPDATE guide_day SET drive_km = $1, drive_minutes = $2 WHERE id = $3`,
          [
            Number((totalDistance / 1000).toFixed(2)),
            Math.round(totalDuration / 60),
            day.id,
          ],
        )
      }

      await client.query(`UPDATE guide SET status = 'confirmed', route_engine = 'amap' WHERE id = $1`, [
        guideId,
      ])
    })

    // 有了真实耗时后把每天的到达时间重排一遍，保证时间轴自洽
    await rescheduleArrivalTimes(guideId)

    res.json({
      ok: true,
      data: {
        legCount: legs.length,
        totalDistanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0),
        skipped,
      },
    })
  }),
)

// ---------------------------------------------------------------------------
// POST /api/guide/:id/revise/stream —— AI 改稿（SSE 流式，原地更新当前攻略）
//
// 事件类型与 generate/stream 完全一致（stage / reasoning / poi / result / error）。
// ---------------------------------------------------------------------------
guideRouter.post(
  '/:id/revise/stream',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guideId = req.params.id

    const instruction = requireText(
      res,
      (req.body as { instruction?: unknown })?.instruction,
      'instruction',
    )
    if (!instruction) return

    const exists = await queryOne<{ id: string }>('SELECT id FROM guide WHERE id = $1', [guideId])
    if (!exists) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    let closed = false
    res.on('close', () => {
      closed = true
    })

    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const started = Date.now()

    try {
      const result = await reviseGuide({ guideId, instruction }, (event) => {
        if (event.type === 'reasoning') {
          send('reasoning', { text: event.text })
        } else if (event.type === 'stage') {
          send('stage', { stage: event.stage, message: event.message })
        } else {
          send('poi', event)
        }
      })

      const guide = await loadGuide(guideId)
      send('result', {
        guide,
        issues: result.issues,
        stats: { ...result.stats, elapsedMs: Date.now() - started },
      })
    } catch (error) {
      console.error('[revise/stream] 失败：', error)
      send('error', { message: (error as Error).message || '改稿失败' })
    } finally {
      if (!closed) res.end()
    }
  }),
)

// ---------------------------------------------------------------------------
// POST /api/guide/:id/replan/stream —— AI 重排时间轴（SSE 流式）
//
// 与 revise/stream 的区别：这里只调整节点的**顺序 / 所属天 / 到达时间**，
// 模型只回「节点 id + 建议时间」，服务端据此只更新 day_id/seq/arrive_time，
// 因此节点既不新增也不删除，只重新安排导航。
//
// 请求体可选 { affectedDays: number[] }：只重排这些天（时间轴编辑只改了某一天时用），
// 其余天原样保留；另外只有「没有停留时长的新节点」允许模型补 stay_minutes / tips。
//
// 事件类型：
//   stage     { stage, message }
//   reasoning { text }
//   replan    { guide, summary }  重排完成后的完整攻略与改动统计
//   error     { message }
// ---------------------------------------------------------------------------
guideRouter.post(
  '/:id/replan/stream',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guideId = req.params.id

    const exists = await queryOne<{ id: string }>('SELECT id FROM guide WHERE id = $1', [guideId])
    if (!exists) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }

    // 前端只把「这次真正改动的天」传上来（换了出发 / 住宿地时还会带上相邻的天），
    // 其余天不参与重排。缺省（不传）则按老行为重排全部天。
    const { affectedDays } = (req.body ?? {}) as { affectedDays?: unknown }
    const scopedDays = Array.isArray(affectedDays)
      ? affectedDays.map((item) => Number(item)).filter((item) => Number.isFinite(item))
      : undefined

    const { send } = openSseChannel(res)

    try {
      const result = await replanGuide({ guideId, affectedDays: scopedDays }, (event) => {
        if (event.type === 'reasoning') {
          send('reasoning', { text: event.text })
        } else if (event.type === 'stage') {
          send('stage', { stage: event.stage, message: event.message })
        }
      })

      const guide = await loadGuide(guideId)
      send('replan', {
        guide,
        summary: {
          total: result.total,
          movedDays: result.movedDays,
          reordered: result.reordered,
          retimed: result.retimed,
          filled: result.filled,
        },
      })
    } catch (error) {
      console.error('[replan/stream] 失败：', error)
      send('error', { message: (error as Error).message || '重排失败' })
    } finally {
      if (!res.writableEnded) res.end()
    }
  }),
)

// ---------------------------------------------------------------------------
// GET /api/guide/:id/text —— 返回攻略手册所需的纯文本结构（后续生成 PDF 用）
// ---------------------------------------------------------------------------
guideRouter.get(
  '/:id/text',
  requireUuidParam('id'),
  asyncHandler(async (req, res) => {
    const guide = await loadGuide(req.params.id)
    if (!guide) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }

    const routes = await query<{
      day_id: string | null
      from_id: string
      to_id: string
      distance_m: number | null
      duration_s: number | null
      from_name: string
      to_name: string
    }>(
      `SELECT r.day_id, r.from_poi_id AS from_id, r.to_poi_id AS to_id,
              r.distance_m, r.duration_s,
              f.name AS from_name, t.name AS to_name
         FROM guide_route r
         LEFT JOIN guide_poi f ON f.id = r.from_poi_id
         LEFT JOIN guide_poi t ON t.id = r.to_poi_id
        WHERE r.guide_id = $1
        ORDER BY r.day_id, r.seq`,
      [req.params.id],
    )

    const KIND_TEXT: Record<string, string> = {
      spot: '景点',
      view: '观景',
      town: '城镇',
      meal: '用餐',
      drive: '赶路',
      rest: '休整',
    }

    const lines: string[] = [`# ${guide.title}`, '', guide.summary ?? '', '']
    for (const day of guide.days) {
      lines.push(`## 第 ${day.day_index} 天 · ${day.title ?? ''}`)
      if (day.summary) lines.push(day.summary)
      if (day.route_text) lines.push(`路线：${day.route_text}`)
      if (day.stay_text) lines.push(`住宿：${day.stay_text}`)
      if (day.drive_km !== null) {
        lines.push(
          `车程：约 ${day.drive_km} km` +
            (day.drive_hours ? `（${day.drive_hours}）` : `（预计 ${day.drive_minutes ?? '-'} 分钟）`),
        )
      }
      const altitude: string[] = []
      if (day.sleep_altitude_m !== null) altitude.push(`住宿海拔 ${day.sleep_altitude_m} m`)
      if (day.max_altitude_m !== null) altitude.push(`最高海拔 ${day.max_altitude_m} m`)
      if (altitude.length > 0) lines.push(`海拔：${altitude.join('，')}`)
      if (day.highlights) lines.push(`看点：${day.highlights}`)
      if (day.cautions) lines.push(`注意：${day.cautions}`)
      for (const note of day.notes) lines.push(`> ${note}`)

      lines.push('', '时间轴：')
      for (const poi of day.pois) {
        const tags = [poi.kind ? KIND_TEXT[poi.kind] ?? poi.kind : '']
        if (poi.priority === 'key') tags.push('关键')
        else if (poi.priority === 'optional') tags.push('可选')
        lines.push(
          `- ${poi.arrive_time ?? '--:--'} **${poi.name}**` +
            `（${tags.filter(Boolean).join('·')}）` +
            (poi.stay_minutes ? `，建议停留 ${poi.stay_minutes} 分钟` : '') +
            (poi.leg_km ? `，距上一节点 ${poi.leg_km} km` : ''),
        )
        if (poi.notes) lines.push(`  玩法：${poi.notes}`)
        if (poi.warnings) lines.push(`  提醒：${poi.warnings}`)
        if (poi.tips) lines.push(`  建议：${poi.tips}`)
        if (poi.address) lines.push(`  位置：${poi.address}`)
      }
      const dayRoutes = routes.filter((route) => route.day_id === day.id)
      if (dayRoutes.length > 0) {
        lines.push('', '驾车路段：')
        for (const route of dayRoutes) {
          lines.push(
            `  · ${route.from_name} → ${route.to_name}：` +
              `${((route.distance_m ?? 0) / 1000).toFixed(1)} km，` +
              `约 ${Math.round((route.duration_s ?? 0) / 60)} 分钟`,
          )
        }
      }
      lines.push('')
    }

    res.json({ ok: true, data: { markdown: lines.join('\n') } })
  }),
)

// ---------------------------------------------------------------------------
// 内部：读取完整攻略（天 + 点位）
// ---------------------------------------------------------------------------
async function loadGuide(guideId: string): Promise<GuideDto | null> {
  const guideRow = await queryOne<{
    id: string
    title: string
    region: string | null
    prompt: string | null
    summary: string | null
    total_days: number
    status: string
    created_at: Date
    archived_at: Date | null
  }>(
    `SELECT id, title, region, prompt, summary, total_days, status, created_at, archived_at
       FROM guide WHERE id = $1`,
    [guideId],
  )
  if (!guideRow) return null

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
    drive_minutes: number | null
    sleep_altitude_m: number | null
    max_altitude_m: number | null
    notes: unknown
  }>(
    `SELECT id, day_index, title, summary, route_text, stay_text, highlights, cautions,
            drive_km, drive_hours, drive_minutes, sleep_altitude_m, max_altitude_m, notes
       FROM guide_day WHERE guide_id = $1 ORDER BY day_index`,
    [guideId],
  )

  const poiRows = await query<{
    id: string
    day_id: string | null
    seq: number
    arrive_time: string | null
    name: string
    kind: GuidePoiDto['kind']
    priority: GuidePoiDto['priority']
    city: string | null
    address: string | null
    lng: number | null
    lat: number | null
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
    geocode_status: GuidePoiDto['geocode_status']
    geocode_provider: string | null
    verified: boolean
  }>(
    `SELECT id, day_id, seq, arrive_time, name, kind, priority, city, address, lng, lat,
            stay_minutes, notes, warnings, tips, leg_km,
            detail, highlights, best_time, photo_keywords, photos,
            geocode_status, geocode_provider, verified
       FROM guide_poi WHERE guide_id = $1 ORDER BY day_id, seq`,
    [guideId],
  )

  const days: GuideDayDto[] = dayRows.map((day) => ({
    id: day.id,
    day_index: day.day_index,
    title: day.title,
    summary: day.summary,
    route_text: day.route_text,
    stay_text: day.stay_text,
    highlights: day.highlights,
    cautions: day.cautions,
    drive_km: num(day.drive_km),
    drive_hours: day.drive_hours,
    drive_minutes: day.drive_minutes,
    sleep_altitude_m: day.sleep_altitude_m,
    max_altitude_m: day.max_altitude_m,
    notes: Array.isArray(day.notes) ? (day.notes as string[]) : [],
    pois: poiRows
      .filter((poi) => poi.day_id === day.id)
      .sort((a, b) => a.seq - b.seq)
      .map((poi) => ({
        id: poi.id,
        day_id: poi.day_id,
        seq: poi.seq,
        arrive_time: poi.arrive_time,
        name: poi.name,
        kind: poi.kind,
        priority: poi.priority,
        city: poi.city,
        address: poi.address,
        lng: num(poi.lng),
        lat: num(poi.lat),
        stay_minutes: poi.stay_minutes,
        notes: poi.notes,
        warnings: poi.warnings,
        tips: poi.tips,
        detail: poi.detail,
        highlights: toStringList(poi.highlights),
        best_time: poi.best_time,
        photo_keywords: toStringList(poi.photo_keywords),
        photos: toPhotoList(poi.photos),
        leg_km: num(poi.leg_km),
        geocode_status: poi.geocode_status,
        geocode_provider: poi.geocode_provider,
        verified: poi.verified,
      })),
  }))

  const routeRows = await query<{
    id: string
    day_id: string | null
    from_poi_id: string | null
    to_poi_id: string | null
    seq: number
    transfer: boolean
    path: [number, number][] | null
    distance_m: number | null
    duration_s: number | null
    from_name: string | null
    to_name: string | null
  }>(
    `SELECT r.id, r.day_id, r.from_poi_id, r.to_poi_id, r.seq, r.transfer,
            r.path, r.distance_m, r.duration_s,
            f.name AS from_name, t.name AS to_name
       FROM guide_route r
       LEFT JOIN guide_poi f ON f.id = r.from_poi_id
       LEFT JOIN guide_poi t ON t.id = r.to_poi_id
      WHERE r.guide_id = $1
      ORDER BY r.day_id, r.seq`,
    [guideId],
  )

  const routes: GuideRouteDto[] = routeRows.map((route) => ({
    id: route.id,
    day_id: route.day_id,
    from_poi_id: route.from_poi_id,
    to_poi_id: route.to_poi_id,
    seq: route.seq,
    transfer: route.transfer,
    path: Array.isArray(route.path) ? route.path : [],
    distance_m: route.distance_m,
    duration_s: route.duration_s,
    from_name: route.from_name,
    to_name: route.to_name,
  }))

  return {
    id: guideRow.id,
    title: guideRow.title,
    region: guideRow.region,
    prompt: guideRow.prompt,
    summary: guideRow.summary,
    total_days: guideRow.total_days,
    status: guideRow.status,
    created_at: guideRow.created_at.toISOString(),
    archived_at: guideRow.archived_at ? guideRow.archived_at.toISOString() : null,
    days,
    routes,
  }
}
