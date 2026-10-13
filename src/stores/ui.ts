import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useGuideStore } from './guide'
import type { GuideDto, GuideSavePayload, NodeKind, NodePriority } from '@/types/guide'

/** 主区域视图：地图工作台 / 攻略库 */
export type ShellView = 'map' | 'library'

/**
 * 编辑器草稿。
 *
 * 全部字段以字符串形式保存，便于直接 v-model 到表单控件；
 * 数值字段在 toSavePayload() 里统一转换，空串即 null。
 */
export interface DraftPoi {
  key: string
  id: string | null
  name: string
  kind: NodeKind
  priority: NodePriority
  arrive_time: string
  stay_minutes: string
  leg_km: string
  city: string
  address: string
  lng: string
  lat: string
  notes: string
  warnings: string
  tips: string
  /** 坐标是否被人工改动过（保存时标记 manual + verified） */
  manualCoord: boolean
}

export interface DraftDay {
  key: string
  id: string | null
  day_index: number
  title: string
  summary: string
  route_text: string
  stay_text: string
  highlights: string
  cautions: string
  drive_km: string
  drive_hours: string
  sleep_altitude_m: string
  max_altitude_m: string
  /** 每行一条提示 */
  notesText: string
  pois: DraftPoi[]
}

export interface DraftGuide {
  id: string
  title: string
  region: string
  summary: string
  archived: boolean
  days: DraftDay[]
}

let seq = 0
function uid(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

function toStr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

function toNum(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function emptyPoi(): DraftPoi {
  return {
    key: uid('poi'),
    id: null,
    name: '',
    kind: 'spot',
    priority: 'normal',
    arrive_time: '',
    stay_minutes: '',
    leg_km: '',
    city: '',
    address: '',
    lng: '',
    lat: '',
    notes: '',
    warnings: '',
    tips: '',
    manualCoord: false,
  }
}

function emptyDay(dayIndex: number): DraftDay {
  return {
    key: uid('day'),
    id: null,
    day_index: dayIndex,
    title: '',
    summary: '',
    route_text: '',
    stay_text: '',
    highlights: '',
    cautions: '',
    drive_km: '',
    drive_hours: '',
    sleep_altitude_m: '',
    max_altitude_m: '',
    notesText: '',
    pois: [],
  }
}

export const useUiStore = defineStore('ui', () => {
  const activeView = ref<ShellView>('map')

  /** 编辑器 */
  const editorOpen = ref(false)
  const draft = ref<DraftGuide | null>(null)

  /** 正在地图上拾取坐标的节点 key（非空时处于拾取模式） */
  const pickingPoiKey = ref<string | null>(null)

  /** 地图上正在查看详情的景点 id（非空时显示详情弹窗） */
  const poiPopupId = ref<string | null>(null)

  function openPoiPopup(poiId: string): void {
    poiPopupId.value = poiId
  }

  function closePoiPopup(): void {
    poiPopupId.value = null
  }

  /** 攻略库刷新信号：编辑器保存后自增，列表监听它重新拉取 */
  const libraryVersion = ref(0)

  function bumpLibrary(): void {
    libraryVersion.value += 1
  }

  const pickingPoiName = computed(() => {
    if (!pickingPoiKey.value || !draft.value) return ''
    for (const day of draft.value.days) {
      const poi = day.pois.find((item) => item.key === pickingPoiKey.value)
      if (poi) return poi.name || '未命名节点'
    }
    return ''
  })

  function setView(view: ShellView): void {
    activeView.value = view
  }

  // ---------- 草稿构造 ----------
  function toDraft(guide: GuideDto): DraftGuide {
    return {
      id: guide.id,
      title: guide.title,
      region: guide.region ?? '',
      summary: guide.summary ?? '',
      archived: guide.archived_at !== null,
      days: guide.days.map((day) => ({
        key: uid('day'),
        id: day.id,
        day_index: day.day_index,
        title: day.title ?? '',
        summary: day.summary ?? '',
        route_text: day.route_text ?? '',
        stay_text: day.stay_text ?? '',
        highlights: day.highlights ?? '',
        cautions: day.cautions ?? '',
        drive_km: toStr(day.drive_km),
        drive_hours: day.drive_hours ?? '',
        sleep_altitude_m: toStr(day.sleep_altitude_m),
        max_altitude_m: toStr(day.max_altitude_m),
        notesText: (day.notes ?? []).join('\n'),
        pois: day.pois.map((poi) => ({
          key: uid('poi'),
          id: poi.id,
          name: poi.name,
          kind: poi.kind,
          priority: poi.priority,
          arrive_time: poi.arrive_time ?? '',
          stay_minutes: toStr(poi.stay_minutes),
          leg_km: toStr(poi.leg_km),
          city: poi.city ?? '',
          address: poi.address ?? '',
          lng: toStr(poi.lng),
          lat: toStr(poi.lat),
          notes: poi.notes ?? '',
          warnings: poi.warnings ?? '',
          tips: poi.tips ?? '',
          manualCoord: false,
        })),
      })),
    }
  }

  /** 编辑器里被折叠的天（key） */
  const editorCollapsed = ref<string[]>([])

  function toggleEditorCollapsed(dayKey: string): void {
    const index = editorCollapsed.value.indexOf(dayKey)
    if (index >= 0) editorCollapsed.value.splice(index, 1)
    else editorCollapsed.value.push(dayKey)
  }

  function openEditor(guide: GuideDto): void {
    const next = toDraft(guide)
    draft.value = next
    // 默认只展开第一天，避免一屏铺满表单
    editorCollapsed.value = next.days.slice(1).map((day) => day.key)
    editorOpen.value = true
  }

  function closeEditor(): void {
    editorOpen.value = false
    pickingPoiKey.value = null
  }

  function discardDraft(): void {
    draft.value = null
  }

  /**
   * 打开的攻略换了人，编辑器草稿就失效了。
   *
   * 草稿里存的是**上一份攻略**的天 / 节点 id，切走之后如果还开着保存，
   * PUT 会带着这些 id 打到新攻略上：新攻略原有的天因为「不在载荷里」
   * 会被整批删掉，写进去的全是上一份攻略的内容。所以一旦发现不是同一份，直接丢弃。
   */
  const guideStore = useGuideStore()
  watch(
    () => guideStore.guide?.id ?? null,
    (id) => {
      if (!draft.value || draft.value.id === id) return
      draft.value = null
      editorOpen.value = false
      pickingPoiKey.value = null
    },
  )

  // ---------- 查节点 ----------
  function findPoi(poiKey: string): DraftPoi | null {
    if (!draft.value) return null
    for (const day of draft.value.days) {
      const poi = day.pois.find((item) => item.key === poiKey)
      if (poi) return poi
    }
    return null
  }

  function findDay(dayKey: string): DraftDay | null {
    return draft.value?.days.find((day) => day.key === dayKey) ?? null
  }

  // ---------- 地图拾取坐标 ----------
  function startPicking(poiKey: string): void {
    pickingPoiKey.value = poiKey
    poiPopupId.value = null
    // 先把地图露出来，再把编辑器收起
    activeView.value = 'map'
    editorOpen.value = false
  }

  function backToEditor(): void {
    pickingPoiKey.value = null
    activeView.value = 'library'
    if (draft.value) editorOpen.value = true
  }

  function cancelPicking(): void {
    backToEditor()
  }

  function applyPicked(lng: number, lat: number): void {
    const poi = pickingPoiKey.value ? findPoi(pickingPoiKey.value) : null
    if (poi) {
      poi.lng = lng.toFixed(6)
      poi.lat = lat.toFixed(6)
      poi.manualCoord = true
    }
    backToEditor()
  }

  function clearPoiCoord(poiKey: string): void {
    const poi = findPoi(poiKey)
    if (!poi) return
    poi.lng = ''
    poi.lat = ''
    poi.manualCoord = true
  }

  // ---------- 天 / 节点增删排序 ----------
  function renumberDays(): void {
    draft.value?.days.forEach((day, index) => {
      day.day_index = index + 1
    })
  }

  function addDay(): void {
    if (!draft.value) return
    const maxIndex = draft.value.days.reduce((max, day) => Math.max(max, day.day_index), 0)
    draft.value.days.push(emptyDay(maxIndex + 1))
  }

  function removeDay(dayKey: string): void {
    if (!draft.value) return
    draft.value.days = draft.value.days.filter((day) => day.key !== dayKey)
    renumberDays()
  }

  function moveDay(dayKey: string, delta: -1 | 1): void {
    if (!draft.value) return
    const days = draft.value.days
    const index = days.findIndex((day) => day.key === dayKey)
    const target = index + delta
    if (index < 0 || target < 0 || target >= days.length) return
    const [item] = days.splice(index, 1)
    days.splice(target, 0, item)
    renumberDays()
  }

  function addPoi(dayKey: string): string | null {
    const day = findDay(dayKey)
    if (!day) return null
    const poi = emptyPoi()
    day.pois.push(poi)
    return poi.key
  }

  function removePoi(dayKey: string, poiKey: string): void {
    const day = findDay(dayKey)
    if (!day) return
    day.pois = day.pois.filter((poi) => poi.key !== poiKey)
  }

  function movePoi(dayKey: string, poiKey: string, delta: -1 | 1): void {
    const day = findDay(dayKey)
    if (!day) return
    const index = day.pois.findIndex((poi) => poi.key === poiKey)
    const target = index + delta
    if (index < 0 || target < 0 || target >= day.pois.length) return
    const [item] = day.pois.splice(index, 1)
    day.pois.splice(target, 0, item)
  }

  // ---------- 导出保存载荷 ----------
  function toSavePayload(): GuideSavePayload | null {
    if (!draft.value) return null
    const current = draft.value
    return {
      title: current.title.trim() || undefined,
      region: current.region.trim() || null,
      summary: current.summary.trim() || null,
      days: current.days.map((day) => ({
        id: day.id,
        day_index: day.day_index,
        title: day.title.trim() || null,
        summary: day.summary.trim() || null,
        route_text: day.route_text.trim() || null,
        stay_text: day.stay_text.trim() || null,
        highlights: day.highlights.trim() || null,
        cautions: day.cautions.trim() || null,
        drive_km: toNum(day.drive_km),
        drive_hours: day.drive_hours.trim() || null,
        sleep_altitude_m: toNum(day.sleep_altitude_m),
        max_altitude_m: toNum(day.max_altitude_m),
        notes: day.notesText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        pois: day.pois.map((poi) => ({
          id: poi.id,
          name: poi.name.trim() || '未命名节点',
          kind: poi.kind,
          priority: poi.priority,
          arrive_time: poi.arrive_time.trim() || null,
          stay_minutes: toNum(poi.stay_minutes),
          leg_km: toNum(poi.leg_km),
          city: poi.city.trim() || null,
          address: poi.address.trim() || null,
          lng: toNum(poi.lng),
          lat: toNum(poi.lat),
          notes: poi.notes.trim() || null,
          warnings: poi.warnings.trim() || null,
          tips: poi.tips.trim() || null,
          manual: poi.manualCoord,
        })),
      })),
    }
  }

  return {
    activeView,
    editorOpen,
    draft,
    pickingPoiKey,
    pickingPoiName,
    poiPopupId,
    openPoiPopup,
    closePoiPopup,
    editorCollapsed,
    toggleEditorCollapsed,
    libraryVersion,
    bumpLibrary,
    setView,
    openEditor,
    closeEditor,
    discardDraft,
    findDay,
    findPoi,
    startPicking,
    cancelPicking,
    applyPicked,
    clearPoiCoord,
    addDay,
    removeDay,
    moveDay,
    addPoi,
    removePoi,
    movePoi,
    toSavePayload,
  }
})
