/**
 * 排查用：把一份攻略在数据库里的实际数据全量打印出来（天数轴 / 节点坐标 / 行车路线）。
 *
 * 什么时候用：怀疑「行程排得不对」时，先看落库的真实数据 ——
 * 这样能分清是模型输出的问题，还是落点解析、入库环节的问题。
 *
 * 用法（server 目录下）：
 *   npx tsx scripts/inspect-guide.ts                     # 最近一份攻略
 *   npx tsx scripts/inspect-guide.ts --title 川西        # 按标题模糊匹配
 *   npx tsx scripts/inspect-guide.ts --id 0c5fd661-...   # 按 id 精确匹配
 *
 * 配置读取统一交给 src/config（config.env > 根 .env > server/.env），
 * 这里不要再 import 'dotenv/config'，否则 server/.env 会抢先于 config.env 生效。
 */
import { Client } from 'pg'
import { config } from '../src/config'

interface GuideRow {
  id: string
  title: string
  created_at: Date
  raw_llm: { days?: { day_index: number; stay?: string; route?: string }[] } | null
}

interface PoiRow {
  day_index: number
  seq: number
  kind: string
  priority: string
  arrive_time: string | null
  name: string
  city: string | null
  lng: number | null
  lat: number | null
  geocode_status: string
  leg_km: number | null
}

interface RouteRow {
  day_index: number | null
  transfer: boolean
  seq: number
  distance_m: number | null
  f: string | null
  tt: string | null
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const id = readArg(args, '--id')
  const title = readArg(args, '--title')

  const client = new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  })
  await client.connect()

  const guide = (
    await client.query<GuideRow>(
      `SELECT id, title, created_at, raw_llm
         FROM guide
        WHERE ($1::text IS NULL OR id::text = $1)
          AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%')
        ORDER BY created_at DESC
        LIMIT 1`,
      [id ?? null, title ?? null],
    )
  ).rows[0]

  if (!guide) {
    console.log(id ? `没找到 id=${id} 的攻略` : `没找到标题包含「${title}」的攻略`)
    await client.end()
    return
  }

  console.log('====', guide.title, '|', guide.created_at.toISOString(), '|', guide.id)

  // 模型原始输出：先看 AI 到底排了什么，再和下面的落库结果对照
  for (const day of guide.raw_llm?.days ?? []) {
    console.log(
      `  RAW D${day.day_index} stay=${JSON.stringify(day.stay)} route=${JSON.stringify(day.route)}`,
    )
  }

  const pois = await client.query<PoiRow>(
    `SELECT d.day_index, p.seq, p.kind, p.priority, p.arrive_time, p.name, p.city,
            p.lng, p.lat, p.geocode_status, p.leg_km
       FROM guide_poi p
       JOIN guide_day d ON d.id = p.day_id
      WHERE p.guide_id = $1
      ORDER BY d.day_index, p.seq`,
    [guide.id],
  )
  console.log('---- NODES ----')
  for (const p of pois.rows) {
    const coord =
      p.lng === null || p.lat === null
        ? '          --        '
        : `${p.lng.toFixed(3)},${p.lat.toFixed(3)}`
    console.log(
      `  D${String(p.day_index).padStart(2)} #${p.seq} [${p.kind}/${p.priority}] ` +
        `${p.arrive_time || '--:--'} ${coord} ${p.geocode_status.padEnd(8)} ` +
        `leg=${p.leg_km ?? '-'} :: ${p.name}`,
    )
  }

  const routes = await client.query<RouteRow>(
    `SELECT d.day_index, r.transfer, r.seq, r.distance_m,
            f.name AS f, t.name AS tt
       FROM guide_route r
       LEFT JOIN guide_day d ON d.id = r.day_id
       LEFT JOIN guide_poi f ON f.id = r.from_poi_id
       LEFT JOIN guide_poi t ON t.id = r.to_poi_id
      WHERE r.guide_id = $1
      ORDER BY d.day_index, r.transfer, r.seq`,
    [guide.id],
  )
  console.log('---- ROUTES ----')
  for (const r of routes.rows) {
    console.log(
      `  D${String(r.day_index ?? '-').padStart(2)} ${r.transfer ? 'TRANSFER' : '        '} #${r.seq} ` +
        `${String(r.distance_m ?? '-').padStart(7)}m  ${r.f} -> ${r.tt}`,
    )
  }

  console.log('nodes =', pois.rows.length, ' routes =', routes.rows.length)
  await client.end()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('ERR:', error)
    process.exit(1)
  })