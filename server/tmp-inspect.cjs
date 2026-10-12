require('dotenv/config')
const { Client } = require('pg')

const client = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'travel_guide',
})

async function main() {
  await client.connect()
  const g = await client.query(
    `SELECT id, title, created_at, raw_llm FROM guide ORDER BY created_at DESC LIMIT 1`,
  )
  const guide = g.rows[0]
  console.log('====', guide.title, '|', guide.created_at.toISOString())

  const raw = guide.raw_llm || {}
  for (const day of raw.days || []) {
    console.log(
      `  RAW D${day.day_index} stay=${JSON.stringify(day.stay)} route=${JSON.stringify(day.route)}`,
    )
  }

  const pois = await client.query(
    `SELECT d.day_index, p.seq, p.kind, p.priority, p.arrive_time, p.name, p.city,
            p.lng, p.lat, p.geocode_status, p.leg_km
       FROM guide_poi p JOIN guide_day d ON d.id = p.day_id
      WHERE p.guide_id = $1 ORDER BY d.day_index, p.seq`,
    [guide.id],
  )
  console.log('---- NODES ----')
  for (const p of pois.rows) {
    const coord =
      p.lng === null ? '          --        ' : `${Number(p.lng).toFixed(3)},${Number(p.lat).toFixed(3)}`
    console.log(
      `  D${String(p.day_index).padStart(2)} #${p.seq} [${p.kind}/${p.priority}] ${p.arrive_time || '--:--'} ` +
        `${coord} ${p.geocode_status.padEnd(8)} leg=${p.leg_km ?? '-'} :: ${p.name}`,
    )
  }

  const routes = await client.query(
    `SELECT d.day_index, r.transfer, r.seq, r.distance_m, f.name AS f, t.name AS tt
       FROM guide_route r
       LEFT JOIN guide_day d ON d.id = r.day_id
       LEFT JOIN guide_poi f ON f.id = r.from_poi_id
       LEFT JOIN guide_poi t ON t.id = r.to_poi_id
      WHERE r.guide_id = $1 ORDER BY d.day_index, r.transfer, r.seq`,
    [guide.id],
  )
  console.log('---- ROUTES ----')
  for (const r of routes.rows) {
    console.log(
      `  D${String(r.day_index).padStart(2)} ${r.transfer ? 'TRANSFER' : '        '} #${r.seq} ` +
        `${String(r.distance_m ?? '-').padStart(7)}m  ${r.f} -> ${r.tt}`,
    )
  }
  console.log('nodes =', pois.rows.length, ' routes =', routes.rows.length)
  await client.end()
}

main().catch((e) => {
  console.error('ERR:', e.message)
  process.exit(1)
})
