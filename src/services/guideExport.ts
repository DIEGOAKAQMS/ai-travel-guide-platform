import * as Cesium from 'cesium'
import { dayColor } from '@/config/guide'
import { LEGEND_ITEMS, findStartPoiId, legendKeyOf, type LegendKey } from '@/config/mapIcons'
import type { GuideDayDto, GuideDto, GuidePoiDto, GuideRouteDto, NodeKind } from '@/types/guide'
import { EXPORT_CSS } from './exportStyles'
import { renderGuide, type RenderOptions } from './guideRenderer'

/**
 * 导出「单文件自包含」的攻略 HTML。
 *
 * - 版式沿用 travel-guide-html 技能沉淀的设计系统（见 exportStyles.ts）
 * - 内含两张路线图，都取自「整条行程俯视全览」的固定机位：
 *   一张「住宿 + 导航路线」，一张「景点 + 导航路线」，右下角各带天数配色图例。
 *   底图保留天地图卫星影像，路线由导出逻辑自己描到截图上（见 drawRoutesOnSnapshot），
 *   截完镜头与渲染参数原样复原，用户眼前的画面与选中态都不会被改动。
 */

/** 一张导出用的路线图 */
export interface RouteMapShot {
  title: string
  caption: string
  image: string
}

interface ShotSpec {
  title: string
  caption: string
  /** 这张图里额外保留的标记类型（导航路线由导出时统一描上去，不用列在这里） */
  keep: LegendKey[]
}

/** 导出的两张图：分别突出住宿点 / 景点，路线两张都叠 */
const SHOT_SPECS: ShotSpec[] = [
  {
    title: '住宿 + 导航路线',
    caption: '标出每天的住宿落点与驾车路线，用来核对「住哪儿、每天跑多远」。',
    keep: ['lodging'],
  },
  {
    title: '景点 + 导航路线',
    caption: '标出沿途景点与驾车路线，用来核对游玩落点和先后顺序。',
    keep: ['spot'],
  },
]

/** 截图最大宽度（px）：整份 HTML 是单文件，图片不能太肥 */
const SNAPSHOT_MAX_WIDTH = 1280
/** JPEG 质量 */
const SNAPSHOT_QUALITY = 0.82

const STAY_LABEL: Record<NodeKind, string> = {
  spot: '游玩',
  view: '游玩',
  town: '住宿',
  meal: '用餐',
  drive: '行驶',
  rest: '休整',
}

// ---------------------------------------------------------------- 小工具

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 经纬度点位（能画到地图上的节点） */
function hasCoord(poi: GuidePoiDto): boolean {
  return poi.lng !== null && poi.lat !== null
}

function kmText(meters: number | null): string {
  if (!meters || meters <= 0) return ''
  const km = meters / 1000
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`
}

function minutesText(minutes: number | null): string {
  if (!minutes || minutes <= 0) return ''
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** 海拔：> 4000 m 一律用紫色 ▲（设计系统硬约定） */
function altText(meters: number | null | undefined, inline = true): string {
  if (meters === null || meters === undefined || meters <= 0) return '—'
  const text = `${Math.round(meters)} m`
  return meters > 4000 ? `<span class="${inline ? 'alt4k-inline' : 'alt4k'}">${text}</span>` : text
}

/** 某节点出发的那一段路：优先当天内路段，其次跨天转移段 */
function outgoingRoute(poi: GuidePoiDto, routes: GuideRouteDto[]): GuideRouteDto | null {
  return (
    routes.find((route) => route.from_poi_id === poi.id && !route.transfer) ??
    routes.find((route) => route.from_poi_id === poi.id) ??
    null
  )
}

function totalDistanceM(guide: GuideDto): number {
  const fromRoutes = guide.routes.reduce((sum, route) => sum + (route.distance_m ?? 0), 0)
  if (fromRoutes > 0) return fromRoutes
  return guide.days.reduce((sum, day) => sum + (day.drive_km ?? 0), 0) * 1000
}

/** 全程最高海拔（取各天「当日最高」与「住宿海拔」的最大值） */
function peakAltitudeM(guide: GuideDto): number {
  let peak = 0
  for (const day of guide.days) {
    peak = Math.max(peak, day.max_altitude_m ?? 0, day.sleep_altitude_m ?? 0)
  }
  return peak
}

function dayAltitudeSpan(day: GuideDayDto): string {
  const sleep = day.sleep_altitude_m
  const peak = day.max_altitude_m
  if (!sleep && !peak) return '—'
  if (sleep && peak && peak !== sleep) return `${altText(sleep)} → ${altText(peak)}`
  return altText(sleep ?? peak)
}

/** 每天的里程：优先用后端算好的 drive_km，否则按当天路段里程求和 */
function dayDistanceKm(day: GuideDayDto, routes: GuideRouteDto[]): number {
  if (day.drive_km) return day.drive_km
  const meters = routes.reduce((sum, route) => {
    const belongsToDay = day.pois.some((poi) => poi.id === route.from_poi_id)
    return belongsToDay ? sum + (route.distance_m ?? 0) : sum
  }, 0)
  return meters / 1000
}

function dayTitle(day: GuideDayDto): string {
  if (day.title) return day.title
  if (day.route_text) return day.route_text
  const names = day.pois.filter(hasCoord).map((poi) => poi.name)
  if (names.length === 0) return `第 ${day.day_index} 天`
  return `${names[0]} → ${names[names.length - 1]}`
}

// ---------------------------------------------------------------- HTML 片段

function renderTimeline(day: GuideDayDto, routes: GuideRouteDto[]): string {
  const items = day.pois
    .map((poi) => {
      const classes: string[] = []
      if (poi.kind === 'drive') classes.push('drive')
      const leg = outgoingRoute(poi, routes)
      if (leg) classes.push('has-leg')

      const badges: string[] = []
      const stay = minutesText(poi.stay_minutes)
      if (stay) badges.push(`<span class="stay">${STAY_LABEL[poi.kind]} ${stay}</span>`)
      if (poi.priority === 'key') badges.push('<span class="stay red">关键</span>')
      else if (poi.priority === 'optional') badges.push('<span class="stay gold">可选</span>')

      const location = [poi.city, poi.address].filter(Boolean).join(' · ')
      const detail = location ? `<div class="ds">📍 ${esc(location)}</div>` : ''

      let legHtml = ''
      if (leg) {
        const distance = kmText(leg.distance_m)
        legHtml =
          `<div class="leg">${esc(poi.name)}<span class="arw">→</span>` +
          `${esc(leg.to_name ?? '下一站')}${distance ? ` · ≈ ${distance}` : ''}</div>`
      }

      const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
      return (
        `<li${cls}><span class="tm">${esc(poi.arrive_time ?? '--:--')}</span>` +
        `<div class="stop">${esc(poi.name)}${badges.join('')}</div>${detail}${legHtml}</li>`
      )
    })
    .join('')

  return `<ul class="tl">${items}</ul>`
}

/** 景点攻略块：把「玩法 / 避坑 / 建议」集中展示；没有这三项的节点不进这个块 */
function renderSpots(day: GuideDayDto): string {
  const items = day.pois
    .filter((poi) => poi.notes || poi.warnings || poi.tips)
    .map((poi) => {
      const stay = minutesText(poi.stay_minutes)
      const tick = stay ? `<span class="tick">${STAY_LABEL[poi.kind]} ${stay}</span>` : ''
      const desc = poi.notes ? `<div class="desc">${esc(poi.notes)}</div>` : ''
      const good = poi.tips ? `<span class="good">${esc(poi.tips)}</span>` : ''
      const warn = poi.warnings ? `<span class="warn">${esc(poi.warnings)}</span>` : ''
      return `<div class="spot-item"><div class="name">${esc(poi.name)}${tick}</div>${desc}${good}${warn}</div>`
    })
    .join('')

  if (!items) return ''
  return (
    '<div class="spot"><div class="spot-head"><span class="zh">📍</span>' +
    ' 景点攻略 &amp; 注意事项</div>' +
    `${items}</div>`
  )
}

function renderDayCard(day: GuideDayDto, routes: GuideRouteDto[]): string {
  const kv: string[] = []

  const routeText = day.route_text
  if (routeText) kv.push(`<div class="kv"><span class="k">路线</span><span class="v">${esc(routeText)}</span></div>`)

  const stayParts: string[] = []
  if (day.stay_text) stayParts.push(esc(day.stay_text))
  if (day.sleep_altitude_m) stayParts.push(`住宿海拔 ${altText(day.sleep_altitude_m)}`)
  if (stayParts.length > 0) {
    kv.push(`<div class="kv"><span class="k gold">住</span><span class="v">${stayParts.join(' · ')}</span></div>`)
  }

  if (day.highlights) {
    kv.push(`<div class="kv"><span class="k">看点</span><span class="v">${esc(day.highlights)}</span></div>`)
  }
  if (day.cautions) {
    kv.push(`<div class="kv high"><span class="k high">注意</span><span class="v">${esc(day.cautions)}</span></div>`)
  }

  const meta: string[] = []
  const km = dayDistanceKm(day, routes)
  if (km > 0) meta.push(`约 ${Math.round(km)} km`)
  if (day.drive_hours) meta.push(day.drive_hours)
  const span = dayAltitudeSpan(day)
  if (span !== '—') meta.push(`海拔 ${span}`)

  const noteLines = [day.summary, ...day.notes].filter(Boolean).map((line) => esc(line))
  const note =
    noteLines.length > 0
      ? `<div class="note"><b>当日小结：</b>${noteLines.join('<br>')}</div>`
      : ''

  return (
    '<div class="day">' +
    '<div class="day-head">' +
    `<div class="day-badge"><b>D${day.day_index}</b><span>DAY ${day.day_index}</span></div>` +
    `<div class="t"><h4>${esc(dayTitle(day))}</h4>` +
    `<div class="meta">${esc(meta.join(' · ')) || '当天行程'}</div></div>` +
    '</div>' +
    '<div class="day-body">' +
    kv.join('') +
    note +
    '<h3 style="margin:14px 0 10px;font-size:14px;">⏱ 当日时间轴</h3>' +
    renderTimeline(day, routes) +
    renderSpots(day) +
    '</div></div>'
  )
}

/** 路线流向：按顺序取可落点节点，去重相邻同名 */
function renderRouteFlow(guide: GuideDto): string {
  const names: string[] = []
  for (const day of guide.days) {
    for (const poi of day.pois) {
      if (!hasCoord(poi)) continue
      if (names[names.length - 1] !== poi.name) names.push(poi.name)
    }
  }
  if (names.length === 0) return ''

  const shown =
    names.length > 18
      ? [...names.slice(0, 15), `… 中间 ${names.length - 17} 站 …`, ...names.slice(-2)]
      : names

  return shown
    .map((name, index) => {
      const isEdge = index === 0 || index === shown.length - 1
      return `<span class="node${isEdge ? ' hi' : ''}">${esc(name)}</span>`
    })
    .join('<span class="arw">→</span>')
}

function renderMasterTable(guide: GuideDto): string {
  const rows = guide.days
    .map((day) => {
      const km = dayDistanceKm(day, guide.routes)
      return (
        `<tr><td><b>D${day.day_index}</b></td>` +
        `<td>${esc(day.route_text ?? dayTitle(day))}</td>` +
        `<td>${km > 0 ? `约 ${Math.round(km)} km` : '—'}</td>` +
        `<td>${esc(day.drive_hours ?? '—')}</td>` +
        `<td>${esc(day.stay_text ?? '—')}</td>` +
        `<td class="teal">${altText(day.sleep_altitude_m)}</td>` +
        `<td>${altText(day.max_altitude_m, false)}</td></tr>`
      )
    })
    .join('')

  const totalKm = totalDistanceM(guide) / 1000
  const peak = peakAltitudeM(guide)
  const summary =
    `<tr style="background:#eef2f1;"><td><b>合计</b></td>` +
    `<td><b>${guide.total_days} 天</b></td>` +
    `<td><b>约 ${Math.round(totalKm)} km</b></td><td>—</td>` +
    `<td colspan="3"><b>全程最高点 ${peak > 0 ? altText(peak) : '—'}</b></td></tr>`

  return (
    '<div class="tbl-scroll"><table>' +
    '<tr><th>日期</th><th>行程安排</th><th>里程</th><th>车程</th>' +
    '<th>住宿地</th><th>住宿海拔</th><th>当日最高海拔</th></tr>' +
    rows +
    summary +
    '</table></div>'
  )
}

/** 住宿海拔速查：有海拔数据才生成 */
function renderAltitudeSection(guide: GuideDto): string {
  const days = guide.days.filter((day) => day.sleep_altitude_m || day.max_altitude_m)
  if (days.length === 0) return ''

  const rows = days
    .map(
      (day) =>
        `<tr><td><b>D${day.day_index} ${esc(day.stay_text ?? '')}</b></td>` +
        `<td>${altText(day.sleep_altitude_m)}</td>` +
        `<td>${altText(day.max_altitude_m, false)}</td></tr>`,
    )
    .join('')

  const chain = days.map((day) => (day.sleep_altitude_m ? Math.round(day.sleep_altitude_m) : '—')).join(' → ')

  return (
    '<section><h2>海拔速查 <span class="en">ALTITUDE</span></h2>' +
    '<div class="tbl-scroll"><table>' +
    '<tr><th>天 / 住宿</th><th>住宿海拔</th><th>当日最高海拔</th></tr>' +
    rows +
    '</table></div>' +
    `<div class="note"><b>住宿海拔曲线：</b>${esc(chain)} m —— 住宿尽量走「低 → 高 → 低」的缓坡，` +
    '让身体逐步适应；紫色 <span class="alt4k-inline">4000 m+</span> 为高海拔区，当晚不宜洗澡、饮酒与剧烈活动。</div>' +
    '</section>'
  )
}

/** 路线图右下角的天数配色图例：颜色与 drawRoutesOnSnapshot 描路线用的 dayColor 一致 */
function dayLegendHtml(guide: GuideDto): string {
  const days = [...guide.days].sort((a, b) => a.day_index - b.day_index)
  if (days.length === 0) return ''
  const items = days
    .map(
      (day) =>
        `<span class="map-legend__item"><i style="background:${dayColor(day.day_index)}"></i>D${day.day_index}</span>`,
    )
    .join('')
  return `<div class="map-legend">${items}</div>`
}

// ---------------------------------------------------------------- 组装

export function buildGuideHtml(guide: GuideDto, maps: RouteMapShot[]): string {
  const totalKm = Math.round(totalDistanceM(guide) / 1000)
  const peak = peakAltitudeM(guide)
  const stationCount = guide.days.reduce((sum, day) => sum + day.pois.filter(hasCoord).length, 0)

  const tags = [
    `共 ${guide.total_days} 天`,
    totalKm > 0 ? `全程约 ${totalKm} km` : '',
    stationCount > 0 ? `途经 ${stationCount} 站` : '',
    peak > 0 ? `最高海拔 ${Math.round(peak)} m` : '',
    guide.region ?? '',
  ]
    .filter(Boolean)
    .map((text) => `<span>${esc(text)}</span>`)
    .join('')

  const mapSection =
    maps.length > 0
      ? '<section><h2>路线图 <span class="en">ROUTE MAP</span></h2>' +
        maps
          .map(
            (shot) =>
              `<h3>${esc(shot.title)}</h3>` +
              `<div class="map-card"><img src="${shot.image}" alt="${esc(shot.title)}">` +
              dayLegendHtml(guide) +
              '</div>' +
              `<div class="note">${esc(shot.caption)}` +
              '截图为<b>整条行程的俯视全览</b>（固定机位，与页面当前视角无关）：底图是' +
              '<b>天地图卫星影像</b>，上面叠加了全程<b>导航路线</b>（沿线的 ' +
              '<b>&gt;&gt;&gt;</b> 箭头指向行驶方向）与该图对应的标记，' +
              '用来核对路线走向与各点相对位置。</div>',
          )
          .join('') +
        '</section>'
      : ''

  const routeFlow = renderRouteFlow(guide)

  /** 「逐日行程详解」图例里的天数配色：每天一段导航路线，色条与图上描的路线一致 */
  const dayLegendItems = [...guide.days]
    .sort((a, b) => a.day_index - b.day_index)
    .map((day) => `<span><i style="background:${dayColor(day.day_index)}"></i>D${day.day_index}</span>`)
    .join('')
  const dayLegendGroup = dayLegendItems ? `<span class="legend__days">${dayLegendItems}</span>` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(guide.title)} · 行程攻略</title>
<style>${EXPORT_CSS}</style>
</head>
<body>

<div class="hero">
  <div class="wrap">
    <div class="kicker">${esc(guide.region ? `${guide.region} · TRAVEL GUIDE` : 'TRAVEL GUIDE')}</div>
    <h1>${esc(guide.title)}${guide.region ? ` <em>${esc(guide.region)}</em>` : ''}<br>共 ${
      guide.total_days
    } 天${totalKm > 0 ? ` · 全程约 ${totalKm} km` : ''}</h1>
    ${guide.summary ? `<p class="sub">${esc(guide.summary)}</p>` : ''}
    <div class="tags">${tags}</div>
  </div>
</div>

<div class="wrap">

  <section>
    <h2>行程总览 <span class="en">OVERVIEW</span></h2>
    <div class="grid">
      <div class="stat"><div class="num">${guide.total_days}<small>天</small></div><div class="lbl">总行程</div></div>
      <div class="stat"><div class="num">${totalKm}<small>km</small></div><div class="lbl">自驾里程</div></div>
      <div class="stat"><div class="num">${stationCount}<small>站</small></div><div class="lbl">可定位节点</div></div>
      <div class="stat"><div class="num">${peak > 0 ? Math.round(peak) : '—'}<small>${
        peak > 0 ? 'm' : ''
      }</small></div><div class="lbl">全程最高海拔</div></div>
    </div>
    ${
      routeFlow
        ? `<div class="route-strip"><h3 style="margin-top:0;">路线流向</h3><div class="route-flow">${routeFlow}</div></div>`
        : ''
    }
  </section>

  ${mapSection}

  <section>
    <h2>每日安排一览表 <span class="en">MASTER SCHEDULE</span></h2>
    ${renderMasterTable(guide)}
  </section>

  <section>
    <h2>逐日行程详解 <span class="en">DAY BY DAY</span></h2>
    <div class="legend" style="margin-bottom:14px;">
      <span><i class="d3"></i>停留 / 游玩</span>
      <span><i style="background:#d97706"></i>🚗 开车赶路</span>
      <span><i class="d1"></i>关键节点</span>
      <span><i class="d2"></i>可选节点</span>
      <span style="color:#2c5f6d;font-weight:800;">↓ 两地之间 = 分段里程</span>
      ${dayLegendGroup}
    </div>
    ${guide.days.map((day) => renderDayCard(day, guide.routes)).join('')}
  </section>

  ${renderAltitudeSection(guide)}

  <footer>
    ${esc(guide.title)} · 共 ${guide.total_days} 天${totalKm > 0 ? ` · 约 ${totalKm} km` : ''}<br>
    由「旅游攻略管理平台」导出 · 里程与路线为规划数据，出行前请以实时路况与官方公告为准<br>
    <b>安全第一，风景第二</b>
  </footer>

</div>
</body>
</html>
`
}

// ---------------------------------------------------------------- 场景截图

/** 等卫星瓦片加载完成的最长时间（毫秒）；标签页隐藏 / 主线程被占用时兜底，避免导出卡死 */
const TILES_TIMEOUT_MS = 8_000
/** 至少先画这么多帧再读像素：切镜头 / 切图层后的头一两帧画面还没稳 */
const SETTLE_MIN_FRAMES = 8

/** 等到视野内的卫星瓦片全部加载完成，否则截出来是空白（或半截）瓦片 */
function waitTilesLoaded(scene: Cesium.Scene, minFrames = SETTLE_MIN_FRAMES): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0
    let timer = 0
    const done = () => {
      window.clearTimeout(timer)
      remove?.()
      resolve()
    }
    const remove = scene.postRender.addEventListener(() => {
      frames += 1
      if (frames >= minFrames && scene.globe?.tilesLoaded) done()
    })
    scene.requestRender()
    timer = window.setTimeout(done, TILES_TIMEOUT_MS)
  })
}

/** 经纬度包围盒 */
interface LngLatBounds {
  west: number
  south: number
  east: number
  north: number
}

/** 整条行程的经纬度包围盒（路线折线 + 所有可落点节点） */
function guideBounds(guide: GuideDto): LngLatBounds | null {
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY

  const extend = (lng: number, lat: number) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }

  for (const route of guide.routes) {
    for (const [lng, lat] of route.path ?? []) extend(lng, lat)
  }
  for (const day of guide.days) {
    for (const poi of day.pois) {
      if (poi.lng === null || poi.lat === null) continue
      extend(poi.lng, poi.lat)
    }
  }

  return Number.isFinite(west) ? { west, south, east, north } : null
}

/** 1 度纬度约等于多少米（经度按 cos(lat) 折算） */
const METERS_PER_DEGREE = 111_320
/** 全览留白系数：1 表示刚好铺满视野，越大越松 */
const OVERVIEW_MARGIN = 1.35
/** 全览镜头最低高度，避免行程极短时镜头贴地 */
const OVERVIEW_MIN_HEIGHT = 8_000

/**
 * 把镜头切到「整条行程俯视全览」：正俯视 + 按行程跨度算视高，
 * 并兼顾画布宽高比，保证横竖两个方向都装得下（不再沿用用户当前视角）。
 */
function frameGuideOverview(viewer: Cesium.Viewer, guide: GuideDto): void {
  const bounds = guideBounds(guide)
  if (!bounds) return

  const canvas = viewer.scene.canvas
  const centerLng = (bounds.west + bounds.east) / 2
  const centerLat = (bounds.south + bounds.north) / 2
  // 经度跨度随纬度收敛，先折算成米再和纬度跨度比较
  const spanXM =
    (bounds.east - bounds.west) * METERS_PER_DEGREE * Math.cos(Cesium.Math.toRadians(centerLat))
  const spanYM = (bounds.north - bounds.south) * METERS_PER_DEGREE

  const frustum = viewer.camera.frustum
  const perspectiveFovy =
    frustum instanceof Cesium.PerspectiveFrustum ? frustum.fovy : undefined
  const fovy = perspectiveFovy ?? Cesium.Math.toRadians(60)
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect)

  const heightForY = spanYM / 2 / Math.tan(fovy / 2)
  const heightForX = spanXM / 2 / Math.tan(fovx / 2)
  const height = Math.max(heightForY, heightForX) * OVERVIEW_MARGIN

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      centerLng,
      centerLat,
      Math.max(height, OVERVIEW_MIN_HEIGHT),
    ),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
}

/** 白底铺满 + 把 Cesium 场景按上限宽度缩进去，返回可继续叠加绘制的 2D 画布 */
function createSnapshotCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const scale = Math.min(1, SNAPSHOT_MAX_WIDTH / Math.max(1, source.width))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))

  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** 跨天转移段的虚线节奏（与导出 CSS 里的图例说明一致） */
const TRANSFER_DASH: [number, number] = [10, 8]
/** 默认路线色（找不到对应天时兜底） */
const FALLBACK_ROUTE_COLOR = '#2f7dfa'
/**
 * 路线画法对齐地图上的「粗线 + 线内箭头」观感（见 guideRenderer 的箭头材质）：
 * 线身 12px、白色描边 16px、箭头整体嵌在线身里。
 */
/** 线身宽度（px）——与地图上的 ROUTE_LINE_WIDTH 保持一致 */
const ROUTE_LINE_PX = 12
/** 白色描边宽度（px）：卫星影像上光靠彩色线容易糊，先用白边「托」一层 */
const ROUTE_CASING_PX = 16
/** 前进方向箭头的屏幕间距（px）：按最终图片尺寸算，任何缩放级别下疏密都一致 */
const ROUTE_ARROW_SPACING_PX = 64
/**
 * 箭头（「>」形）的臂长、两翼张开半角（弧度）、笔画粗细。
 * 箭头横向半宽 = size * sin(spread) ≈ 4px，加上半个笔画 1.5px 仍小于线身半宽 6px，
 * 所以箭头是「嵌在线的面里」的。
 */
const ROUTE_ARROW_SIZE_PX = 7.5
const ROUTE_ARROW_SPREAD = 0.56
const ROUTE_ARROW_STROKE_PX = 3

/** 截图 canvas 上的像素点 */
interface SnapshotPoint {
  x: number
  y: number
}

/** 箭头：位置 + 朝向（弧度，指向前进方向） */
interface RouteArrow {
  x: number
  y: number
  angle: number
}

/**
 * 沿折线均匀取样出前进方向箭头（按屏幕长度等分，两端各留半个间距，避免压住起终点标记）。
 * 折线太短（不足 1.5 个间距）就不放箭头，免得又短又挤。
 */
function sampleRouteArrows(points: SnapshotPoint[], spacing: number): RouteArrow[] {
  const segments: { from: SnapshotPoint; to: SnapshotPoint; length: number }[] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    segments.push({ from, to, length })
    total += length
  }
  if (total < spacing * 1.5) return []

  const count = Math.max(1, Math.floor(total / spacing))
  const step = total / count

  const arrows: RouteArrow[] = []
  let cursor = 0
  let walked = 0
  for (let index = 0; index < count; index += 1) {
    const target = step * (index + 0.5)
    while (cursor < segments.length - 1 && walked + segments[cursor].length < target) {
      walked += segments[cursor].length
      cursor += 1
    }
    const segment = segments[cursor]
    const ratio = segment.length > 0 ? (target - walked) / segment.length : 0
    arrows.push({
      x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
      y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      angle: Math.atan2(segment.to.y - segment.from.y, segment.to.x - segment.from.x),
    })
  }
  return arrows
}

/** 画一个「>」形箭头：顶点指向前进方向，两条臂向后张开 */
function traceArrow(
  context: CanvasRenderingContext2D,
  arrow: RouteArrow,
  size: number,
): void {
  const back = arrow.angle + Math.PI
  context.beginPath()
  context.moveTo(
    arrow.x + Math.cos(back - ROUTE_ARROW_SPREAD) * size,
    arrow.y + Math.sin(back - ROUTE_ARROW_SPREAD) * size,
  )
  context.lineTo(arrow.x, arrow.y)
  context.lineTo(
    arrow.x + Math.cos(back + ROUTE_ARROW_SPREAD) * size,
    arrow.y + Math.sin(back + ROUTE_ARROW_SPREAD) * size,
  )
  context.stroke()
}

/**
 * 把导航路线画到截图 canvas 上。
 *
 * 特意不走 Cesium 的贴地折线：地面折线的几何是在 Worker 里异步构建的，
 * 截帧时经常还没提交，导出的图就会「有标记、没路线」。这里改成按当前相机
 * 自己把经纬度投影成屏幕坐标再描线，结果稳定可控，还顺手加了白色描边，
 * 免得彩色线埋在卫星影像里看不清；最后沿路补一串前进方向箭头。
 */
function drawRoutesOnSnapshot(scene: Cesium.Scene, guide: GuideDto, canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d')
  if (!context) return

  const source = scene.canvas
  // 投影得到的是 CSS 像素，乘这个比例换算到缩放后的画布像素（含 devicePixelRatio）
  const ratio = canvas.width / Math.max(1, source.clientWidth)

  const project = (lng: number, lat: number): SnapshotPoint | null => {
    const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      Cesium.Cartesian3.fromDegrees(lng, lat),
    )
    return windowPos ? { x: windowPos.x * ratio, y: windowPos.y * ratio } : null
  }

  const legs: { color: string; dashed: boolean; points: SnapshotPoint[] }[] = []
  for (const route of guide.routes) {
    const points: SnapshotPoint[] = []
    for (const [lng, lat] of route.path ?? []) {
      const point = project(lng, lat)
      if (point) points.push(point)
    }
    if (points.length < 2) continue
    const day = guide.days.find((item) => item.id === route.day_id)
    legs.push({
      color: day ? dayColor(day.day_index) : FALLBACK_ROUTE_COLOR,
      dashed: route.transfer,
      points,
    })
  }
  if (legs.length === 0) return

  const trace = (points: SnapshotPoint[]) => {
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y)
    }
  }

  context.save()
  context.lineJoin = 'round'
  context.lineCap = 'round'

  // 1) 先统一铺白描边：把彩线从卫星影像里「托」出来
  context.setLineDash([])
  context.strokeStyle = 'rgba(255, 255, 255, 0.92)'
  context.lineWidth = ROUTE_CASING_PX
  for (const leg of legs) {
    trace(leg.points)
    context.stroke()
  }

  // 2) 再画彩色线身：跨天转移段用虚线，和地图图例保持一致
  context.globalAlpha = 0.95
  for (const leg of legs) {
    context.setLineDash(leg.dashed ? TRANSFER_DASH : [])
    context.strokeStyle = leg.color
    context.lineWidth = leg.dashed ? ROUTE_LINE_PX - 2 : ROUTE_LINE_PX
    trace(leg.points)
    context.stroke()
  }

  // 3) 最后沿路补一排白色箭头：落在彩色线身内部，和高德导航那种观感一致
  context.globalAlpha = 1
  context.setLineDash([])
  context.strokeStyle = '#ffffff'
  context.lineWidth = ROUTE_ARROW_STROKE_PX

  const arrowsByLeg = legs.map((leg) => sampleRouteArrows(leg.points, ROUTE_ARROW_SPACING_PX))
  for (const arrows of arrowsByLeg) {
    for (const arrow of arrows) traceArrow(context, arrow, ROUTE_ARROW_SIZE_PX)
  }

  context.restore()
}

/** 这份攻略里是否存在某个分类的可落点节点（没有就不出这张图，免得只有一条光秃秃的路线） */
function hasCategory(guide: GuideDto, keep: LegendKey[]): boolean {
  const startPoiId = findStartPoiId(guide)
  for (const day of guide.days) {
    for (const poi of day.pois) {
      if (!hasCoord(poi)) continue
      if (keep.includes(legendKeyOf(poi, startPoiId))) return true
    }
  }
  return false
}

/**
 * 生成导出用的路线图（住宿 + 导航路线 / 起点 + 导航路线）。
 *
 * 与页面上的视角无关：先把镜头固定切到「整条行程俯视全览」，再逐张
 * 「只留该图对应的标记」重绘 → 等卫星瓦片到齐 → 截帧 → 由 drawRoutesOnSnapshot
 * 把导航路线描上去。全部截完把镜头与渲染参数原样复原，
 * 因此用户眼前的画面、选中与高亮态都不会被改动。
 */
export async function captureRouteMaps(
  viewer: Cesium.Viewer | null,
  guide: GuideDto | null,
  options: RenderOptions,
): Promise<RouteMapShot[]> {
  if (!viewer || viewer.isDestroyed() || !guide) return []

  const specs = SHOT_SPECS.filter((spec) => hasCategory(guide, spec.keep))
  if (specs.length === 0) return []

  const scene = viewer.scene
  const camera = viewer.camera
  const allKeys = LEGEND_ITEMS.map((item) => item.key)

  // 记住用户原本的镜头，截完原样还回去
  const savedView = {
    destination: Cesium.Cartesian3.clone(camera.positionWC),
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  }

  const shots: RouteMapShot[] = []
  try {
    frameGuideOverview(viewer, guide)

    for (const spec of specs) {
      renderGuide(viewer, guide, {
        ...options,
        // 路线图要覆盖整条行程，因此不受时间轴当天显隐影响
        hiddenDays: [],
        // 路线不交给 Cesium 画（见 drawRoutesOnSnapshot），这里只控制标记类型
        hiddenCategories: allKeys.filter((key) => !spec.keep.includes(key)),
        // 截图里不要蓝圈（选中 / 高亮态）
        highlightRouteId: null,
        selectedPoiId: null,
        // 导出的是静态全景图，保留全部标注，不做避让
        labelAvoidance: false,
      })

      await waitTilesLoaded(scene)

      const canvas = createSnapshotCanvas(scene.canvas)
      if (!canvas) {
        console.warn('[guideExport] 场景截图为空，已跳过：', spec.title)
        continue
      }
      drawRoutesOnSnapshot(scene, guide, canvas)

      try {
        shots.push({
          title: spec.title,
          caption: spec.caption,
          image: canvas.toDataURL('image/jpeg', SNAPSHOT_QUALITY),
        })
      } catch (error) {
        // 画布一旦被跨域资源污染，读回像素会抛 SecurityError（丢这张图，不要拖垮整次导出）
        console.warn('[guideExport] 画布读回失败：', error)
      }
    }
    return shots
  } catch (error) {
    console.warn('[guideExport] 场景截图失败：', error)
    return shots
  } finally {
    camera.setView({
      destination: savedView.destination,
      orientation: { heading: savedView.heading, pitch: savedView.pitch, roll: savedView.roll },
    })
    renderGuide(viewer, guide, options)
  }
}

// ---------------------------------------------------------------- 下载

/** 文件名：`<标题>_<导出日期>.html`（标题里的非法字符替换掉，并清掉多余下划线） */
export function guideHtmlFileName(guide: GuideDto, date = new Date()): string {
  const title =
    guide.title
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .slice(0, 60)
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || '行程攻略'
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`
  return `${title}_${stamp}.html`
}

export function downloadHtml(fileName: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 等浏览器接过下载再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
