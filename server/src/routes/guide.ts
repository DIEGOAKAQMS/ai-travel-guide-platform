import { Router, type NextFunction, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { query, queryOne, withTransaction } from '../db/pool'
import { planDriving, searchPoi, type PlaceCandidate } from '../services/amap'
import { generateGuide, reviseGuide, searchKeywords, shortCity } from '../services/guide'
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
    const { prompt, days, region } = req.body as {
      prompt?: string
      days?: number
      region?: string
    }

    if (!prompt || !prompt.trim()) {
      res.status(400).json({ ok: false, error: 'prompt 不能为空' })
      return
    }

    const started = Date.now()
    const result = await generateGuide({
      prompt: prompt.trim(),
      days: days ? Number(days) : undefined,
      region: region?.trim() || undefined,
    })

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
    const { prompt, days, region } = req.body as {
      prompt?: string
      days?: number
      region?: string
    }

    if (!prompt || !prompt.trim()) {
      res.status(400).json({ ok: false, error: 'prompt 不能为空' })
      return
    }

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
        { prompt: prompt.trim(), days: days ? Number(days) : undefined, region: region?.trim() || undefined },
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
// GET /api/guide/:id —— 攻略详情
// ---------------------------------------------------------------------------
guideRouter.get(
  '/:id',
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
  asyncHandler(async (req, res) => {
    const body = req.body as {
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
// ---------------------------------------------------------------------------
guideRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const guideId = req.params.id
    const body = req.body as {
      title?: string
      region?: string | null
      summary?: string | null
      days?: SaveDayPayload[]
    }

    if (!Array.isArray(body.days)) {
      res.status(400).json({ ok: false, error: 'days 必须是数组' })
      return
    }

    const exists = await queryOne<{ id: string }>('SELECT id FROM guide WHERE id = $1', [guideId])
    if (!exists) {
      res.status(404).json({ ok: false, error: '攻略不存在' })
      return
    }

    const days = body.days

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
  asyncHandler(async (req, res) => {
    const { lng, lat, day_id, seq } = req.body as {
      lng?: number
      lat?: number
      day_id?: string
      seq?: number
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
  asyncHandler(async (req, res) => {
    const guideId = req.params.id
    const { instruction } = req.body as { instruction?: string }

    if (!instruction || !instruction.trim()) {
      res.status(400).json({ ok: false, error: 'instruction 不能为空' })
      return
    }

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
      const result = await reviseGuide({ guideId, instruction: instruction.trim() }, (event) => {
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
// GET /api/guide/:id/text —— 返回攻略手册所需的纯文本结构（后续生成 PDF 用）
// ---------------------------------------------------------------------------
guideRouter.get(
  '/:id/text',
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
