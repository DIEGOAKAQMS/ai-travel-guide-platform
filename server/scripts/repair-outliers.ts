/**
 * 已有攻略的「落点飞得很远」修复脚本（默认 dry-run，只打印不写库）。
 *
 * 背景：区域名认不出来时 bbox 会退化成全国范围，加上高德的跨省同名匹配
 * （「阿斯哈图石林」→ 云南石林、「热水塘」→ 云南保山），老攻略里会残留
 * 距离行程中心几千公里的错误落点。这里复用生成时的离群复核逻辑重解一次。
 *
 * 用法（在 server 目录下执行）：
 *   npx tsx scripts/repair-outliers.ts <guideId>          # 预览某条攻略会被怎么改
 *   npx tsx scripts/repair-outliers.ts <guideId> --apply  # 写回数据库
 *   npx tsx scripts/repair-outliers.ts --all              # 扫描全部攻略（仅预览）
 */
// 配置读取统一交给 src/config（分层加载 config.env > 根 .env > server/.env），
// 这里不要再 import 'dotenv/config'，否则 server/.env 会先进 process.env、抢在 config.env 前面生效。
import { bboxForRegion } from '../src/config'
import { query, withTransaction } from '../src/db/pool'
import { refineOutliers } from '../src/services/guide'
import type { Bbox, GenerateIssue, GeocodeStatus, LlmNode, NodeKind, NodePriority, ResolvedNode } from '../src/types'

interface PoiRow {
  id: string
  guide_id: string
  guide_title: string
  region: string | null
  day_index: number
  seq: number
  name: string
  kind: string
  priority: string
  city: string | null
  address: string | null
  lng: number | null
  lat: number | null
  lng_gcj: number | null
  lat_gcj: number | null
  geocode_status: GeocodeStatus
  geocode_provider: string | null
  geocode_keyword: string | null
  photos: unknown
}

const SELECT_POIS = `
  SELECT p.id, p.guide_id, g.title AS guide_title, g.region,
         d.day_index, p.seq, p.name, p.kind, p.priority, p.city, p.address,
         p.lng, p.lat, p.lng_gcj, p.lat_gcj,
         p.geocode_status, p.geocode_provider, p.geocode_keyword, p.photos
    FROM guide_poi p
    JOIN guide_day d ON d.id = p.day_id
    JOIN guide g ON g.id = p.guide_id
   WHERE p.guide_id = $1
   ORDER BY d.day_index, p.seq
`

function toResolved(row: PoiRow): ResolvedNode {
  return {
    day_index: row.day_index,
    seq: row.seq,
    name: row.name,
    kind: row.kind as NodeKind,
    priority: row.priority as NodePriority,
    city: row.city ?? undefined,
    address: row.address ?? undefined,
    lng: row.lng ?? undefined,
    lat: row.lat ?? undefined,
    lng_gcj: row.lng_gcj ?? undefined,
    lat_gcj: row.lat_gcj ?? undefined,
    geocode_status: row.geocode_status,
    geocode_provider: row.geocode_provider ?? undefined,
    geocode_keyword: row.geocode_keyword ?? undefined,
  }
}

function toLlmNode(row: PoiRow): LlmNode {
  return { name: row.name, kind: row.kind as NodeKind, city: row.city ?? undefined }
}

async function repairGuide(guideId: string, apply: boolean): Promise<number> {
  const rows = await query<PoiRow>(SELECT_POIS, [guideId])
  if (rows.length === 0) {
    console.log(`（${guideId} 没有点位）`)
    return 0
  }

  const region = rows[0].region
  const [minLng, minLat, maxLng, maxLat] = bboxForRegion(region)
  const bbox: Bbox = { minLng, minLat, maxLng, maxLat }

  const before = rows.map(toResolved)
  const results: { resolved: ResolvedNode; issue?: GenerateIssue }[] = before.map((resolved) => ({
    resolved: { ...resolved },
  }))
  const flat = rows.map((row) => ({ node: toLlmNode(row), dayIndex: row.day_index, seq: row.seq }))

  console.log(`\n=== ${rows[0].guide_title} ===`)
  console.log(`region=${region ?? '-'} | bbox=[${minLng},${minLat},${maxLng},${maxLat}] | 点位 ${rows.length}`)

  await refineOutliers(results, flat, bbox)

  const updates: { row: PoiRow; next: ResolvedNode }[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const prev = before[i]
    const next = results[i].resolved
    const moved =
      prev.lng !== next.lng || prev.lat !== next.lat || prev.geocode_status !== next.geocode_status
    if (!moved) continue
    updates.push({ row: rows[i], next })
    console.log(
      `\n  ● D${rows[i].day_index}-${rows[i].seq + 1} ${rows[i].name}` +
        `\n      旧：${prev.lng ?? '-'},${prev.lat ?? '-'} [${prev.geocode_status}] ${prev.geocode_keyword ?? '-'} ${prev.address ?? ''}` +
        `\n      新：${next.lng ?? '-'},${next.lat ?? '-'} [${next.geocode_status}] ${next.geocode_keyword ?? '-'} ${next.address ?? ''}`,
    )
  }

  if (updates.length === 0) {
    console.log('\n  没有需要修正的点位。')
    return 0
  }

  if (!apply) {
    console.log(`\n  以上 ${updates.length} 个点位为预览（未写库）。加 --apply 才真正写回。`)
    return updates.length
  }

  await withTransaction(async (client) => {
    for (const { row, next } of updates) {
      await client.query(
        `UPDATE guide_poi
            SET lng = $1, lat = $2, lng_gcj = $3, lat_gcj = $4, address = $5,
                geocode_status = $6, geocode_provider = $7, geocode_keyword = $8, photos = $9
          WHERE id = $10`,
        [
          next.lng ?? null,
          next.lat ?? null,
          next.lng_gcj ?? null,
          next.lat_gcj ?? null,
          next.address ?? null,
          next.geocode_status,
          next.geocode_provider ?? null,
          next.geocode_keyword ?? null,
          JSON.stringify(next.photos ?? []),
          row.id,
        ],
      )
    }
  })
  console.log(`\n  已写回 ${updates.length} 个点位。`)
  return updates.length
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const all = args.includes('--all')
  const guideId = args.find((arg) => !arg.startsWith('--'))

  const guides = all
    ? await query<{ id: string; title: string }>(
        `SELECT g.id, g.title FROM guide g
          WHERE EXISTS (SELECT 1 FROM guide_poi p WHERE p.guide_id = g.id)
          ORDER BY g.updated_at DESC`,
      )
    : guideId
      ? await query<{ id: string; title: string }>(`SELECT id, title FROM guide WHERE id = $1`, [
          guideId,
        ])
      : []

  if (guides.length === 0) {
    console.log('用法：tsx scripts/repair-outliers.ts <guideId> [--apply]  或  --all')
    process.exit(1)
  }

  let total = 0
  for (const guide of guides) {
    total += await repairGuide(guide.id, apply)
  }
  console.log(`\n合计需要修正：${total} 个点位${apply ? '（已写回）' : '（预览）'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('修复失败：', error)
    process.exit(1)
  })
