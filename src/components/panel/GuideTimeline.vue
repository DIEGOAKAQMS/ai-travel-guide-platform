<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  KIND_COLOR,
  KIND_ICON,
  KIND_TEXT,
  PRIORITY_TEXT,
  STATUS_TEXT,
  dayColor,
  formatStay,
} from '@/config/guide'
import { useGuideStore } from '@/stores/guide'
import PoiSearchDialog from './PoiSearchDialog.vue'
import type {
  GuideDayDto,
  GuidePoiDto,
  GuideRouteDto,
  GuideSaveDay,
  GuideSavePayload,
  GuideSavePoi,
  NodeKind,
} from '@/types/guide'

const store = useGuideStore()

// ---------------------------------------------------------------------------
// 修改模式：在时间轴上直接增删 / 排序 / 换天，再让 AI 重新安排导航
// ---------------------------------------------------------------------------

/** 编辑草稿里的节点：保存载荷 + 渲染用的 key + 「坐标是否本次搜索确认」 */
interface EditPoi extends GuideSavePoi {
  key: string
  /** 本次编辑中通过高德搜索确认过坐标 → 保存时标记为人工指定 */
  picked: boolean
}

/** 编辑草稿里的一天：保存载荷 + 渲染用的 key */
interface EditDay extends Omit<GuideSaveDay, 'pois'> {
  key: string
  pois: EditPoi[]
}

let editSeq = 0
function editUid(prefix: string): string {
  editSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${editSeq}`
}

/** 是否处于「修改」模式 */
const editing = ref(false)
/** 编辑草稿（仅编辑模式使用，不进 store） */
const draftDays = ref<EditDay[]>([])
/** 编辑模式下当前选中的节点 key（选中后才显示该行的操作条） */
const selectedEditKey = ref<string | null>(null)
/** 「+ 添加行程」的目标天 key（非空时弹出搜索弹窗） */
const addTargetKey = ref<string | null>(null)
/** 保存 + AI 重排进行中 */
const savingEdit = ref(false)
const editError = ref('')

const addTargetDay = computed(
  () => draftDays.value.find((day) => day.key === addTargetKey.value) ?? null,
)

/** 弹窗标题里的目标天文案 */
const addTargetLabel = computed(() => {
  const day = addTargetDay.value
  if (!day) return ''
  return `D${day.day_index}${day.title ? ` · ${day.title}` : ''}`
})

/** 编辑草稿里的节点总数 */
const draftNodeCount = computed(() =>
  draftDays.value.reduce((sum, day) => sum + day.pois.length, 0),
)

/** 把当前攻略拷成一份可变草稿（保存载荷需要的字段全都带上，避免 PUT 写空） */
function buildDraft(): EditDay[] {
  return (store.guide?.days ?? []).map((day) => ({
    key: editUid('day'),
    id: day.id,
    day_index: day.day_index,
    title: day.title,
    summary: day.summary,
    route_text: day.route_text,
    stay_text: day.stay_text,
    highlights: day.highlights,
    cautions: day.cautions,
    drive_km: day.drive_km,
    drive_hours: day.drive_hours,
    sleep_altitude_m: day.sleep_altitude_m,
    max_altitude_m: day.max_altitude_m,
    notes: [...day.notes],
    pois: day.pois.map((poi) => ({
      key: editUid('poi'),
      id: poi.id,
      name: poi.name,
      kind: poi.kind,
      priority: poi.priority,
      arrive_time: poi.arrive_time,
      stay_minutes: poi.stay_minutes,
      leg_km: poi.leg_km,
      city: poi.city,
      address: poi.address,
      lng: poi.lng,
      lat: poi.lat,
      notes: poi.notes,
      warnings: poi.warnings,
      tips: poi.tips,
      picked: false,
    })),
  }))
}

function startEdit(): void {
  if (!store.guide) return
  draftDays.value = buildDraft()
  selectedEditKey.value = null
  editError.value = ''
  editing.value = true
  // 编辑时全部展开，免得来回点
  expandedDays.value = draftDays.value.map((day) => day.day_index)
}

function cancelEdit(): void {
  if (savingEdit.value) return
  editing.value = false
  draftDays.value = []
  selectedEditKey.value = null
  addTargetKey.value = null
  editError.value = ''
}

function selectEdit(poiKey: string): void {
  selectedEditKey.value = selectedEditKey.value === poiKey ? null : poiKey
}

/** 上移 / 下移（同一天内） */
function movePoiEdit(day: EditDay, index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= day.pois.length) return
  const [poi] = day.pois.splice(index, 1)
  day.pois.splice(target, 0, poi)
}

/** 删除节点 */
function removePoiEdit(day: EditDay, index: number): void {
  const [poi] = day.pois.splice(index, 1)
  if (poi && selectedEditKey.value === poi.key) selectedEditKey.value = null
}

/** 移动到行程中的另一天（追加到该天末尾） */
function movePoiToDay(day: EditDay, index: number, event: Event): void {
  const select = event.target as HTMLSelectElement
  const targetKey = select.value
  // 选项是「动作」而非「状态」，选完立刻恢复占位
  select.value = ''
  if (!targetKey) return

  const target = draftDays.value.find((item) => item.key === targetKey)
  if (!target || target.key === day.key) return

  const [poi] = day.pois.splice(index, 1)
  if (!poi) return
  target.pois.push(poi)
  selectedEditKey.value = poi.key
  if (!isExpanded(target.day_index)) expandedDays.value.push(target.day_index)
}

function openAdd(day: EditDay): void {
  addTargetKey.value = day.key
  if (!isExpanded(day.day_index)) expandedDays.value.push(day.day_index)
}

function onAddConfirm(value: {
  name: string
  kind: NodeKind
  city: string | null
  address: string | null
  lng: number
  lat: number
}): void {
  const day = addTargetDay.value
  if (!day) return

  const poi: EditPoi = {
    key: editUid('poi'),
    id: null,
    name: value.name,
    kind: value.kind,
    priority: 'normal',
    arrive_time: null,
    stay_minutes: null,
    leg_km: null,
    city: value.city,
    address: value.address,
    lng: value.lng,
    lat: value.lat,
    notes: null,
    warnings: null,
    tips: null,
    picked: true,
  }
  day.pois.push(poi)
  selectedEditKey.value = poi.key
  addTargetKey.value = null
}

/** 保存草稿 → AI 重新编排顺序与时间 → 按新顺序重算驾车路线 */
async function saveEdit(): Promise<void> {
  if (!store.guide || savingEdit.value) return
  if (draftNodeCount.value === 0) {
    editError.value = '时间轴上至少要保留一个节点'
    return
  }

  const payload: GuideSavePayload = {
    title: store.guide.title,
    region: store.guide.region,
    summary: store.guide.summary,
    days: draftDays.value.map((day) => ({
      id: day.id,
      day_index: day.day_index,
      title: day.title,
      summary: day.summary,
      route_text: day.route_text,
      stay_text: day.stay_text,
      highlights: day.highlights,
      cautions: day.cautions,
      drive_km: day.drive_km,
      drive_hours: day.drive_hours,
      sleep_altitude_m: day.sleep_altitude_m,
      max_altitude_m: day.max_altitude_m,
      notes: day.notes,
      pois: day.pois.map((poi) => ({
        id: poi.id,
        name: poi.name,
        kind: poi.kind,
        priority: poi.priority,
        arrive_time: poi.arrive_time,
        stay_minutes: poi.stay_minutes,
        leg_km: poi.leg_km,
        city: poi.city,
        address: poi.address,
        lng: poi.lng,
        lat: poi.lat,
        notes: poi.notes,
        warnings: poi.warnings,
        tips: poi.tips,
        manual: poi.picked,
      })),
    })),
  }

  savingEdit.value = true
  editError.value = ''
  const ok = await store.saveTimelineAndReplan(payload)
  savingEdit.value = false

  if (ok) {
    editing.value = false
    draftDays.value = []
    selectedEditKey.value = null
  } else {
    editError.value = store.error ?? '保存失败，请重试'
  }
}

/** 整个面板是否收起 */
const collapsed = ref(false)
/** 已展开的天（默认只展开第一天，避免一屏铺满） */
const expandedDays = ref<number[]>([])

/** 节点 DOM 引用：地图上点了图标后，要把对应的行滚动到可见区域 */
const nodeRefs = new Map<string, HTMLElement>()

function setNodeRef(poiId: string, el: unknown): void {
  if (el instanceof HTMLElement) nodeRefs.set(poiId, el)
  else nodeRefs.delete(poiId)
}

const days = computed(() => store.guide?.days ?? [])
const nodeCount = computed(() => days.value.reduce((sum, day) => sum + day.pois.length, 0))
const allExpanded = computed(
  () => days.value.length > 0 && expandedDays.value.length === days.value.length,
)

/**
 * 当天出发时间（首站的 arrive_time）换算成分钟。
 *
 * 时间轴每天的第一个节点就是当天的出发地，所以它的 arrive_time 就是出发时间。
 */
function departureMinutes(day: GuideDayDto): number | null {
  const matched = /^(\d{1,2}):(\d{2})/.exec(day.pois[0]?.arrive_time ?? '')
  if (!matched) return null
  return Number(matched[1]) * 60 + Number(matched[2])
}

/**
 * 全行程的「常规出发时间」：各天出发时间里出现次数最多的那个（并列取最晚）。
 *
 * 有它才能判断某天是不是"比别的天早"：用户要的出发时间是固定的，众数就是那个时间；
 * 模型偶尔会因为赶路 / 看日出把某一天提前，那天的出发时间就会明显早于众数。
 */
const normalDepartureMinutes = computed(() => {
  const counts = new Map<number, number>()
  for (const day of days.value) {
    const minutes = departureMinutes(day)
    if (minutes !== null) counts.set(minutes, (counts.get(minutes) ?? 0) + 1)
  }

  let result: number | null = null
  let bestCount = 0
  for (const [minutes, count] of counts) {
    const laterTie = count === bestCount && result !== null && minutes > result
    if (count > bestCount || laterTie) {
      result = minutes
      bestCount = count
    }
  }
  return result
})

/** 早于常规时间多少分钟才算「提前出发」；差值太小就不值得单独占一行 */
const EARLY_START_MINUTES = 30

/** 这天是否比行程的常规出发时间更早（模板里据此决定是否展示提前出发说明） */
function isEarlyStart(day: GuideDayDto): boolean {
  const minutes = departureMinutes(day)
  const normal = normalDepartureMinutes.value
  return minutes !== null && normal !== null && normal - minutes >= EARLY_START_MINUTES
}

/** 「今日 07:00 出发」里的时间文案：直接用首站的 arrive_time（已是 HH:mm） */
function departureText(day: GuideDayDto): string {
  return day.pois[0]?.arrive_time ?? ''
}

/**
 * 提前出发的原因：提示词要求模型把原因写进当天首站的玩法描述（notes）。
 *
 * 没写就只显示出发时间 —— 那本身也是有效信息（这天确实比别的天早），
 * 顺便把"模型没给理由"这件事暴露出来，而不是悄悄藏掉。
 */
function departureReason(day: GuideDayDto): string {
  return (day.pois[0]?.notes ?? '').trim()
}

/** 地图上每一天是否都被隐藏了 */
const allDaysHidden = computed(
  () =>
    days.value.length > 0 &&
    days.value.every((day) => store.hiddenDays.includes(day.day_index)),
)

/** 当前被高亮的那一段路 */
const activeRoute = computed(
  () => store.guide?.routes.find((route) => route.id === store.highlightedRouteId) ?? null,
)

// 切换攻略时重置展开状态
watch(
  () => store.guide?.id,
  () => {
    expandedDays.value = days.value.length > 0 ? [days.value[0].day_index] : []
    // 草稿是上一份攻略拷出来的（里面的 id 都属于它），换了一份攻略就必须丢掉：
    // 否则接着点「保存并重新规划」，PUT 会带着旧攻略的天 / 节点 id 打到新攻略上，
    // 新攻略原有的行程会被整批删掉。
    if (editing.value) cancelEdit()
  },
  { immediate: true },
)

// 地图上点击图标（或时间轴上点击节点）后，把对应行展开并滚动到可见区域
watch(
  () => store.selectedPoiId,
  async (poiId) => {
    if (!poiId) return
    collapsed.value = false
    const day = days.value.find((item) => item.pois.some((poi) => poi.id === poiId))
    if (day && !isExpanded(day.day_index)) expandedDays.value.push(day.day_index)
    await nextTick()
    nodeRefs.get(poiId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)

function isExpanded(dayIndex: number): boolean {
  return expandedDays.value.includes(dayIndex)
}

function toggleExpand(dayIndex: number): void {
  const index = expandedDays.value.indexOf(dayIndex)
  if (index >= 0) expandedDays.value.splice(index, 1)
  else expandedDays.value.push(dayIndex)
}

function expandAll(): void {
  expandedDays.value = days.value.map((day) => day.day_index)
}

function collapseAll(): void {
  expandedDays.value = []
}

/** 该节点能否被「定位」：有坐标，或赶路节点能对应到一段路线 */
function locatable(poi: GuidePoiDto): boolean {
  if (poi.lng !== null && poi.lat !== null) return true
  if (poi.kind === 'drive') return store.findRouteForNode(poi) !== null
  return false
}

/** 到达该节点的驾车路段（时间轴上的车辆图标就是它） */
function legFor(poi: GuidePoiDto): GuideRouteDto | null {
  return store.findRouteTo(poi)
}

function isRouteActive(route: GuideRouteDto | null): boolean {
  return !!route && route.id === store.highlightedRouteId
}

function isNodeHighlighted(poi: GuidePoiDto): boolean {
  const route = activeRoute.value
  if (!route) return false
  return route.from_poi_id === poi.id || route.to_poi_id === poi.id
}

/** 路段文案：只给里程（预计耗时交给 legDurationText，模板里用蓝色底单独标出） */
function legText(route: GuideRouteDto): string {
  if (route.distance_m !== null) {
    const km = route.distance_m / 1000
    return `行驶 ${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`
  }
  return route.duration_s ? '行驶' : '驾车路段（未规划）'
}

/** 路段的预计耗时：交通时间，模板里用蓝色底与「游玩」时长区分开 */
function legDurationText(route: GuideRouteDto): string {
  return route.duration_s ? `约 ${formatDuration(route.duration_s)}` : ''
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/** 停留时长的名称：按节点类型区分游玩 / 用餐 / 住宿 / 休整 */
const STAY_LABEL: Record<NodeKind, string> = {
  spot: '游玩',
  view: '游玩',
  town: '住宿',
  meal: '用餐',
  drive: '行驶',
  rest: '休整',
}

function stayLabel(poi: GuidePoiDto): string {
  return STAY_LABEL[poi.kind] ?? '停留'
}

/** 地图上「全部显示 / 全部隐藏」 */
function toggleAllDays(): void {
  if (allDaysHidden.value) store.showAllDays()
  else store.hideAllDays()
}

/** 需要提醒的落点状态（skipped 属于正常情况，不提醒） */
function problemStatus(poi: GuidePoiDto): string {
  if (poi.geocode_status === 'ok' || poi.geocode_status === 'manual') return ''
  if (poi.geocode_status === 'skipped') return ''
  return STATUS_TEXT[poi.geocode_status]
}

function select(poi: GuidePoiDto): void {
  store.focusNode(poi)
}

/** 点击车辆图标：定位到这一段导航并高亮 */
function selectRoute(route: GuideRouteDto): void {
  store.focusRoute(route)
}
</script>

<template>
  <section v-if="store.guide" class="tl">
    <header class="tl__head">
      <span class="tl__title">行程时间轴</span>
      <span class="tl__count">
        <template v-if="editing">编辑中 · {{ draftNodeCount }} 节点</template>
        <template v-else>{{ store.guide.total_days }} 天 · {{ nodeCount }} 节点</template>
      </span>
      <div class="tl__head-actions">
        <template v-if="editing">
          <button type="button" class="tl__link" :disabled="savingEdit" @click="cancelEdit">
            取消
          </button>
          <button
            type="button"
            class="tl__link tl__link--primary"
            :disabled="savingEdit"
            @click="saveEdit"
          >
            {{ savingEdit ? '重新规划中…' : '保存并重新规划' }}
          </button>
        </template>
        <template v-else>
          <button
            v-if="!collapsed"
            type="button"
            class="tl__link"
            @click="allExpanded ? collapseAll() : expandAll()"
          >
            {{ allExpanded ? '全部收起' : '全部展开' }}
          </button>
          <button
            v-if="!collapsed"
            type="button"
            class="tl__link"
            :title="allDaysHidden ? '在地图上显示所有天' : '在地图上隐藏所有天'"
            @click="toggleAllDays"
          >
            {{ allDaysHidden ? '全部显示' : '全部隐藏' }}
          </button>
          <button
            v-if="!collapsed"
            type="button"
            class="tl__link tl__link--edit"
            title="修改这条时间轴"
            @click="startEdit"
          >
            修改
          </button>
          <button
            type="button"
            class="tl__link"
            :title="collapsed ? '展开时间轴' : '收起时间轴'"
            @click="collapsed = !collapsed"
          >
            {{ collapsed ? '▸' : '▾' }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="editing" class="tl__tips">
      点节点选中后，可删除 / 上移 / 下移 / 移动到其它天；每天底部的「+ 添加行程」可新增一站。
    </p>
    <!-- 保存 + AI 重排 + 重算路线是一整轮长任务，耗时就取 store 里那份统一计时 -->
    <p v-if="editing && savingEdit" class="tl__tips tl__tips--busy">
      {{ store.stage }}（{{ store.elapsedSec }}s）
    </p>
    <p v-if="editing && editError" class="tl__issues">{{ editError }}</p>

    <p v-if="!editing && !collapsed && store.issues.length > 0" class="tl__issues">
      {{ store.issues.length }} 个节点落点可疑，需人工校正
    </p>

    <div v-if="!collapsed" class="tl__body">
      <!-- ==================== 修改模式：直接编辑草稿 ==================== -->
      <template v-if="editing">
        <article v-for="day in draftDays" :key="day.key" class="tl__day">
          <div class="tl__day-head" @click="toggleExpand(day.day_index)">
            <span class="tl__caret">{{ isExpanded(day.day_index) ? '▾' : '▸' }}</span>
            <span class="tl__dot" :style="{ background: dayColor(day.day_index) }" />
            <span class="tl__day-title" :title="day.title ?? ''">
              D{{ day.day_index }}<template v-if="day.title"> · {{ day.title }}</template>
            </span>
            <span class="tl__day-meta">{{ day.pois.length }} 节点</span>
          </div>

          <ul v-if="isExpanded(day.day_index)" class="tl__nodes">
            <li v-for="(poi, index) in day.pois" :key="poi.key" class="tl__row">
              <button
                type="button"
                class="tl__node"
                :class="{ 'is-selected': selectedEditKey === poi.key }"
                @click="selectEdit(poi.key)"
              >
                <span class="tl__time">{{ poi.arrive_time ?? '--:--' }}</span>

                <span class="tl__rail">
                  <span class="tl__node-dot" :style="{ background: KIND_COLOR[poi.kind] }" />
                </span>

                <span class="tl__content">
                  <span class="tl__name-row">
                    <span class="tl__kind" :title="KIND_TEXT[poi.kind]">
                      {{ KIND_ICON[poi.kind] }}
                    </span>
                    <span class="tl__name">{{ poi.name }}</span>
                    <span v-if="!poi.id" class="tl__badge tl__badge--new">新增</span>
                    <span v-else-if="poi.priority === 'key'" class="tl__badge tl__badge--key">
                      {{ PRIORITY_TEXT.key }}
                    </span>
                  </span>
                  <!-- 地址只在「本次新增」时展示：那是刚确认的结果；
                       已有节点的地址属于只读信息，修改模式下不显示 -->
                  <span v-if="poi.address && !poi.id" class="tl__addr">{{ poi.address }}</span>
                </span>
              </button>

              <!-- 选中这一行后才出现操作条，避免整屏都是按钮 -->
              <div v-if="selectedEditKey === poi.key" class="tl__ops">
                <button
                  type="button"
                  class="btn btn--mini"
                  :disabled="index === 0"
                  @click="movePoiEdit(day, index, -1)"
                >
                  上移
                </button>
                <button
                  type="button"
                  class="btn btn--mini"
                  :disabled="index === day.pois.length - 1"
                  @click="movePoiEdit(day, index, 1)"
                >
                  下移
                </button>
                <label class="tl__ops-move">
                  <span class="tl__ops-label">移动到</span>
                  <select class="tl__ops-select" value="" @change="movePoiToDay(day, index, $event)">
                    <option value="" disabled>选择天</option>
                    <option
                      v-for="target in draftDays"
                      :key="target.key"
                      :value="target.key"
                      :disabled="target.key === day.key"
                    >
                      D{{ target.day_index }}
                    </option>
                  </select>
                </label>
                <button
                  type="button"
                  class="btn btn--mini btn--danger"
                  @click="removePoiEdit(day, index)"
                >
                  删除
                </button>
              </div>
            </li>

            <li>
              <button
                type="button"
                class="tl__add"
                :title="`在 D${day.day_index} 末尾添加一站`"
                @click="openAdd(day)"
              >
                + 添加行程
              </button>
            </li>
          </ul>
        </article>
      </template>

      <template v-else>
      <!-- ==================== 浏览模式：只读时间轴 ==================== -->
      <article
        v-for="day in days"
        :key="day.id"
        class="tl__day"
        :class="{ 'is-off': store.hiddenDays.includes(day.day_index) }"
      >
        <div class="tl__day-head" @click="toggleExpand(day.day_index)">
          <span class="tl__caret">{{ isExpanded(day.day_index) ? '▾' : '▸' }}</span>
          <span class="tl__dot" :style="{ background: dayColor(day.day_index) }" />
          <span class="tl__day-title" :title="day.title ?? ''">
            D{{ day.day_index }}<template v-if="day.title"> · {{ day.title }}</template>
          </span>
          <span class="tl__day-meta">{{ day.pois.length }} 节点</span>
          <button
            type="button"
            class="tl__eye"
            :title="store.hiddenDays.includes(day.day_index) ? '在地图上显示该天' : '在地图上隐藏该天'"
            @click.stop="store.toggleDay(day.day_index)"
          >
            {{ store.hiddenDays.includes(day.day_index) ? '显示' : '隐藏' }}
          </button>
        </div>

        <!-- 收起时给一行摘要，仍能看清当天主线 -->
        <p v-if="!isExpanded(day.day_index)" class="tl__fold-summary">
          {{ day.route_text || day.summary || '展开查看当天时间轴' }}
        </p>

        <template v-else>
          <!-- 时间轴上方只留「在路上」的里程与时间，以及需要注意的提示；
               住宿 / 游玩 / 海拔 / 看点 / 路线串联 / 备注这些介绍性内容不再铺在这里 -->
          <!-- 例外：比行程常规时间更早出发的那天，把「几点走 + 为什么」提到最显眼的位置，
               否则用户只会看到一行比别的天更早的时刻，不知道为什么 -->
          <p v-if="isEarlyStart(day)" class="tl__fact tl__fact--start">
            <b>今日 {{ departureText(day) }} 出发</b><template v-if="departureReason(day)"> · {{ departureReason(day) }}</template>
          </p>

          <ul v-if="day.drive_km" class="tl__facts">
            <li class="is-move">
              <b>行驶</b>{{ day.drive_km }} km<template v-if="day.drive_hours"> · {{ day.drive_hours }}</template>
            </li>
          </ul>

          <p v-if="day.cautions" class="tl__fact tl__fact--warn"><b>注意</b>{{ day.cautions }}</p>

          <ul class="tl__nodes">
            <li v-for="poi in day.pois" :key="poi.id">
              <!-- 路段：竖线上的车辆图标，点击定位并高亮这一段导航 -->
              <button
                v-if="legFor(poi)"
                type="button"
                class="tl__leg"
                :class="{ 'is-active': isRouteActive(legFor(poi)) }"
                :title="`定位并高亮：${legFor(poi)!.from_name ?? ''} → ${legFor(poi)!.to_name ?? ''}`"
                @click="selectRoute(legFor(poi)!)"
              >
                <span class="tl__leg-spacer" />
                <span class="tl__leg-rail">
                  <span class="tl__car">
                    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                      <path
                        d="M6.3 7.2 7.6 3.7A1.6 1.6 0 0 1 9.1 2.7h5.8a1.6 1.6 0 0 1 1.5 1L17.7 7.2H19a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1.2a2 2 0 0 1-3.8 0h-6a2 2 0 0 1-3.8 0H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h1.3Zm1.7 0h8l-.9-2.6a.3.3 0 0 0-.2-.2H9.1a.3.3 0 0 0-.2.2L8 7.2ZM7 12.4a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm10 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"
                      />
                    </svg>
                  </span>
                </span>
                <span class="tl__leg-text">
                  <span class="tl__leg-move">
                    {{ legText(legFor(poi)!) }}<template v-if="legDurationText(legFor(poi)!)"
                      >· {{ legDurationText(legFor(poi)!) }}</template
                    >
                  </span>
                  <em v-if="isRouteActive(legFor(poi))">已高亮</em>
                  <em v-else>点击高亮</em>
                </span>
              </button>

              <!-- 节点 -->
              <button
                :ref="(el) => setNodeRef(poi.id, el)"
                type="button"
                class="tl__node"
                :class="{
                  'is-selected': store.selectedPoiId === poi.id,
                  'is-problem': problemStatus(poi) !== '',
                  'is-muted': poi.priority === 'optional',
                  'is-static': !locatable(poi),
                  'is-navigating': isNodeHighlighted(poi),
                }"
                :disabled="!locatable(poi)"
                @click="select(poi)"
              >
                <span class="tl__time">{{ poi.arrive_time ?? '--:--' }}</span>

                <span class="tl__rail">
                  <span class="tl__node-dot" :style="{ background: KIND_COLOR[poi.kind] }" />
                </span>

                <span class="tl__content">
                  <span class="tl__name-row">
                    <span class="tl__kind" :title="KIND_TEXT[poi.kind]">{{ KIND_ICON[poi.kind] }}</span>
                    <span class="tl__name">{{ poi.name }}</span>
                    <span v-if="poi.priority === 'key'" class="tl__badge tl__badge--key">
                      {{ PRIORITY_TEXT.key }}
                    </span>
                    <span v-else-if="poi.priority === 'optional'" class="tl__badge">
                      {{ PRIORITY_TEXT.optional }}
                    </span>
                  </span>

                  <span class="tl__sub">
                    <span
                      v-if="poi.stay_minutes"
                      class="tl__pill"
                      :class="poi.kind === 'drive' ? 'tl__pill--move' : 'tl__pill--play'"
                    >
                      <svg class="tl__pill-icon" viewBox="0 0 24 24" width="9" height="9" aria-hidden="true">
                        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5h-2v6.2l4.7 2.8 1-1.7L13 12V7Z" />
                      </svg>
                      {{ stayLabel(poi) }} {{ formatStay(poi.stay_minutes) }}
                    </span>
                    <span
                      v-if="poi.leg_km !== null && poi.leg_km > 0"
                      class="tl__pill"
                      title="距上一节点里程（模型估算）"
                    >
                      距上站 {{ poi.leg_km }} km
                    </span>
                    <span v-if="problemStatus(poi)" class="tl__pill tl__pill--warn">
                      {{ problemStatus(poi) }}
                    </span>
                  </span>

                  <span v-if="poi.warnings" class="tl__warn">⚠ {{ poi.warnings }}</span>
                  <span v-if="poi.tips" class="tl__tip">✦ {{ poi.tips }}</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
      </article>
      </template>
    </div>

    <!-- 添加行程：类型选择 → 高德搜索 → 确认地址 -->
    <PoiSearchDialog
      v-if="addTargetDay"
      :day-label="addTargetLabel"
      @close="addTargetKey = null"
      @confirm="onAddConfirm"
    />
  </section>
</template>

<style scoped>
.tl {
  flex: 1 1 auto;
  min-height: 132px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--panel-bg);
  backdrop-filter: blur(8px);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.tl__head {
  display: flex;
  align-items: center;
  /* 宽度不够时整块操作区折到第二行（表头变高），
     而不是把「全部收起」这类按钮文字挤成两行 */
  flex-wrap: wrap;
  gap: 6px 10px;
  flex: 0 0 auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.tl__title {
  flex: 0 0 auto;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.tl__count {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__head-actions {
  flex: 0 0 auto;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

.tl__link {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
}

.tl__link:hover {
  color: var(--accent);
}

.tl__issues {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(217, 134, 0, 0.08);
  color: var(--warn);
  font-size: 11px;
}

.tl__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0 8px;
}

/* ---------- 每天 ---------- */
.tl__day {
  padding: 6px 12px 2px;
  border-bottom: 1px solid var(--border);
}

.tl__day:last-child {
  border-bottom: none;
}

.tl__day.is-off {
  opacity: 0.45;
}

.tl__day-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  margin: 0 -4px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.tl__day-head:hover {
  background: var(--bg-hover);
}

.tl__caret {
  flex: 0 0 auto;
  width: 10px;
  color: var(--text-3);
  font-size: 10px;
}

.tl__dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(23, 43, 77, 0.12);
}

.tl__day-title {
  overflow: hidden;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__day-meta {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--text-3);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.tl__eye {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
}

.tl__eye:hover {
  color: var(--accent);
}

.tl__fold-summary {
  margin: 4px 0 6px 16px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.tl__facts li,
.tl__fact {
  margin: 0;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}

.tl__facts b,
.tl__fact b {
  margin-right: 4px;
  color: var(--text-3);
  font-weight: 500;
}

.tl__fact--warn {
  color: var(--warn);
}

.tl__fact--warn b {
  color: var(--warn);
}

/* 提前出发说明：只有比行程常规时间更早的天才会出现这一行 */
.tl__fact--start {
  margin-top: 6px;
}

.tl__fact--start b {
  color: var(--accent);
  font-weight: 600;
}

/* ---------- 节点 ---------- */
.tl__nodes {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.tl__node {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 4px;
  border-radius: 5px;
  text-align: left;
  transition: background 0.15s;
}

.tl__node:hover:not(:disabled) {
  background: var(--bg-hover);
}

.tl__node:disabled {
  cursor: default;
}

.tl__node.is-selected {
  background: rgba(22, 119, 255, 0.14);
  box-shadow: inset 2px 0 0 var(--accent);
}

.tl__node.is-navigating {
  background: rgba(22, 119, 255, 0.12);
  box-shadow: inset 2px 0 0 var(--highlight);
}

.tl__time {
  flex: 0 0 40px;
  padding-top: 1px;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tl__rail {
  position: relative;
  flex: 0 0 14px;
  display: flex;
  justify-content: center;
}

/* 时间轴竖线 */
.tl__rail::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: -8px;
  width: 1px;
  background: var(--border-strong);
}

.tl__node-dot {
  position: relative;
  z-index: 1;
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px #ffffff;
}

.tl__content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tl__name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.tl__kind {
  color: var(--text-3);
  font-size: 10px;
}

.tl__name {
  color: var(--text-1);
  font-size: 12px;
  font-weight: 500;
  word-break: break-all;
}

.is-muted .tl__name {
  color: var(--text-2);
}

.tl__badge {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--chip-bg);
  color: var(--text-3);
  font-size: 10px;
  line-height: 15px;
}

.tl__badge--key {
  background: rgba(217, 134, 0, 0.14);
  color: var(--warn);
}

.tl__sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tl__pill {
  padding: 0 6px;
  border-radius: 9px;
  background: var(--chip-bg);
  color: var(--text-2);
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.tl__pill--warn {
  background: rgba(224, 74, 74, 0.12);
  color: var(--danger);
}

/* 游玩时长：绿色胶囊 + 时钟图标，与行驶（车辆图标）在视觉上区分开 */
.tl__pill--play {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(18, 160, 107, 0.12);
  color: var(--success);
}

/* 行驶 / 交通耗时：节点用蓝色胶囊，与游玩（绿）区分 */
.tl__pill--move {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 9px;
  background: rgba(47, 125, 250, 0.12);
  color: #2f7dfa;
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

/* 行驶信息整块蓝底：含里程与耗时，每日「行驶」条目与路段文本共用 */
.tl__facts li.is-move,
.tl__leg-move {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 7px;
  border-radius: 8px;
  background: rgba(47, 125, 250, 0.12);
  color: #2f7dfa;
  font-variant-numeric: tabular-nums;
}

.tl__facts li.is-move b {
  color: #2f7dfa;
}

.tl__pill-icon {
  flex: 0 0 auto;
  fill: currentColor;
}

/* ---------- 路段（车辆图标） ---------- */
.tl__leg {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 1px 4px 1px 0;
  min-height: 20px;
  border-radius: 5px;
  text-align: left;
  transition: background 0.15s;
}

.tl__leg:hover {
  background: var(--bg-hover);
}

.tl__leg.is-active {
  background: rgba(22, 119, 255, 0.12);
}

.tl__leg-spacer {
  flex: 0 0 40px;
}

.tl__leg-rail {
  position: relative;
  flex: 0 0 14px;
  display: flex;
  justify-content: center;
  align-items: center;
}

/* 竖线穿过车辆图标 */
.tl__leg-rail::before {
  content: '';
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 1px;
  background: var(--border-strong);
}

.tl__car {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  transition: all 0.15s;
}

.tl__car svg {
  fill: currentColor;
}

.tl__leg:hover .tl__car,
.tl__leg.is-active .tl__car {
  border-color: var(--highlight);
  background: var(--highlight);
  color: #ffffff;
}

.tl__leg-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tl__leg-text em {
  color: var(--text-3);
  font-size: 10px;
  font-style: normal;
}

.tl__leg:hover .tl__leg-text em,
.tl__leg.is-active .tl__leg-text em {
  color: var(--highlight);
}

.tl__warn,
.tl__tip {
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
}

.tl__warn {
  color: var(--warn);
}

.tl__tip {
  color: var(--success);
}

/* ==========================================================================
   修改模式
   ========================================================================== */

.tl__link--edit {
  color: var(--accent);
  font-weight: 500;
}

.tl__link--primary {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #ffffff;
  font-weight: 500;
}

.tl__link--primary:hover {
  background: var(--accent-hover);
  color: #ffffff;
}

.tl__link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tl__tips {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(47, 125, 250, 0.07);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}

.tl__tips--busy {
  color: var(--accent);
}

/* 一行 = 节点 + （选中时的）操作条 */
.tl__row {
  display: flex;
  flex-direction: column;
}

.tl__ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 6px 48px;
  padding: 5px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  background: var(--bg-panel-2);
}

.tl__ops-move {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tl__ops-label {
  color: var(--text-3);
  font-size: 11px;
}

.tl__ops-select {
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-1);
  font-size: 11px;
  outline: none;
}

.tl__ops-select:focus {
  border-color: var(--accent);
}

/* 每天底部的「+ 添加行程」矩形框 */
.tl__add {
  display: block;
  width: 100%;
  margin: 6px 0 4px;
  padding: 6px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  transition: all 0.15s;
}

.tl__add:hover {
  border-color: var(--accent);
  background: rgba(47, 125, 250, 0.06);
  color: var(--accent);
}

.tl__badge--new {
  background: rgba(18, 160, 107, 0.14);
  color: var(--success);
}

.tl__addr {
  overflow: hidden;
  color: var(--text-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn--mini {
  padding: 3px 9px;
  font-size: 11px;
}

.btn--danger {
  border-color: var(--danger);
  color: var(--danger);
}

.btn--danger:hover {
  border-color: var(--danger);
  background: rgba(224, 74, 74, 0.08);
}
</style>
