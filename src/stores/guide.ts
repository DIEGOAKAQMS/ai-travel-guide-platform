import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  clarifyGuideStream,
  generateGuideStream,
  getGuide,
  planGuideRoute,
  replanGuideStream,
  reviseGuideStream,
  saveGuide,
  type ClarifyQuestion,
  type StreamHandlers,
} from '@/api/guide'
import {
  LEGEND_ITEMS,
  findStartPoiId,
  legendKeyOf,
  type LegendEntry,
  type LegendKey,
} from '@/config/mapIcons'
import {
  buildGuideHtml,
  captureRouteMaps,
  downloadHtml,
  guideHtmlFileName,
} from '@/services/guideExport'
import { clearGuideLayer, flyToGuide, flyToPoi, flyToRoute, renderGuide, type RenderOptions } from '@/services/guideRenderer'
import { diffAffectedDays } from '@/services/timelineDiff'
import { useMapStore } from './map'
import type {
  GenerateIssue,
  GeocodeStatus,
  GuideDto,
  GuidePoiDto,
  GuideRouteDto,
  GuideSavePayload,
} from '@/types/guide'

export interface LogLine {
  role: 'user' | 'stage' | 'ok' | 'warn' | 'error'
  text: string
}

const STATUS_LOG_TEXT: Record<GeocodeStatus, string> = {
  ok: '已定位',
  suspect: '位置可疑，需人工校正',
  failed: '未定位到坐标',
  manual: '人工指定',
  skipped: '无需坐标',
}

export const useGuideStore = defineStore('guide', () => {
  const mapStore = useMapStore()

  /** 当前攻略 */
  const guide = ref<GuideDto | null>(null)
  const issues = ref<GenerateIssue[]>([])

  /** 生成过程状态 */
  const generating = ref(false)
  const routing = ref(false)
  /** 正在让 AI 梳理生成前的澄清问题 */
  const clarifying = ref(false)
  /** AI 反问的问题（非空时前端展示问答面板） */
  const clarifyQuestions = ref<ClarifyQuestion[]>([])
  const stage = ref('')
  const reasoning = ref('')

  /** 推理文本只保留尾部这么多字符：长任务下它会累积到几 MB，白白拖慢渲染 */
  const REASONING_KEEP = 4000

  /** 追加推理文本（超长就截尾） */
  function appendReasoning(text: string): void {
    const next = reasoning.value + text
    reasoning.value = next.length > REASONING_KEEP ? next.slice(-REASONING_KEEP) : next
  }
  const poiProgress = ref({ done: 0, total: 0, current: '' })
  const error = ref<string | null>(null)
  const logs = ref<LogLine[]>([])

  /** 是否正在导出 HTML（按钮置灰用） */
  const exporting = ref(false)

  /** 时间轴编辑：是否正在保存 + 重排（按钮置灰用） */
  const savingTimeline = ref(false)

  /**
   * 是否还有长任务在跑（生成 / 改稿 / 提问 / 路线规划 / 时间轴重排）。
   *
   * 各处的「忙」判断过去各写各的，界面上的耗时也就各计各的：
   * 生成一结束计时器就归零，可后面还在跑路线规划 ——
   * 用户看到的秒数和结果日志里的耗时永远是两个数。
   * 这里收敛成一份状态，计时也只剩一个，谁需要就读同一个值。
   */
  const busy = computed(
    () => generating.value || clarifying.value || routing.value || savingTimeline.value,
  )

  /** 当前这轮任务已经跑了多少秒（busy 期间每秒 +1，闲下来归零） */
  const elapsedSec = ref(0)
  let elapsedTimer: number | null = null

  watch(busy, (running) => {
    if (elapsedTimer !== null) {
      window.clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    if (!running) return

    const startedAt = Date.now()
    elapsedSec.value = 0
    // 每秒才更新一次，不会带来渲染压力
    elapsedTimer = window.setInterval(() => {
      elapsedSec.value = Math.floor((Date.now() - startedAt) / 1000)
    }, 1000)
  })

  /** 被隐藏的天（仅影响地图渲染） */
  const hiddenDays = ref<number[]>([])

  /** 被隐藏的图例分类（点位图标类型 / 线类型，仅影响地图渲染） */
  const hiddenCategories = ref<LegendKey[]>([])

  /** 当前被高亮的路线段（点击时间轴上的车辆图标时设置） */
  const highlightedRouteId = ref<string | null>(null)

  /** 当前选中的节点（点击地图图标或时间轴节点时设置，两边联动高亮） */
  const selectedPoiId = ref<string | null>(null)

  /** 整条行程的起点节点 id（右上角图例里的「起点」类） */
  const startPoiId = computed(() => findStartPoiId(guide.value))

  /**
   * 右上角图例条目。
   *
   * 两个显隐控制是**叠加**关系，时间轴（按天）优先、图例（按类型）其次：
   * 一个要素只有「天可见」且「类型可见」时才会画到地图上。
   * 因此数量按时间轴过滤后的结果统计（这样图例数字始终等于地图上真实数量），
   * 但行本身只要数据存在就保留，避免把某天隐藏后图例行整条消失、没法再改回来。
   */
  const legendEntries = computed<LegendEntry[]>(() => {
    const exists = new Set<LegendKey>()
    const visible = new Map<LegendKey, number>()

    const current = guide.value
    if (current) {
      for (const day of current.days) {
        const dayHidden = hiddenDays.value.includes(day.day_index)
        for (const poi of day.pois) {
          if (poi.lng === null || poi.lat === null) continue
          const key = legendKeyOf(poi, startPoiId.value)
          exists.add(key)
          if (!dayHidden) visible.set(key, (visible.get(key) ?? 0) + 1)
        }
      }
      for (const route of current.routes) {
        if (!route.path || route.path.length < 2) continue
        const day = current.days.find((item) => item.id === route.day_id)
        if (!day) continue
        const key: LegendKey = route.transfer ? 'transfer' : 'route'
        exists.add(key)
        if (!hiddenDays.value.includes(day.day_index)) {
          visible.set(key, (visible.get(key) ?? 0) + 1)
        }
      }
    }

    return LEGEND_ITEMS.filter((item) => exists.has(item.key)).map((item) => ({
      item,
      count: visible.get(item.key) ?? 0,
      hidden: hiddenCategories.value.includes(item.key),
    }))
  })

  const allCategoriesHidden = computed(
    () => legendEntries.value.length > 0 && legendEntries.value.every((entry) => entry.hidden),
  )

  let controller: AbortController | null = null

  function pushLog(role: LogLine['role'], text: string): void {
    logs.value.push({ role, text })
    // 防止长时间运行后日志无限增长
    if (logs.value.length > 400) {
      logs.value.splice(0, logs.value.length - 400)
    }
  }

  /** 当前渲染参数（导出截图后要按同一份参数复原画面） */
  function renderOptions(): RenderOptions {
    return {
      hiddenDays: hiddenDays.value,
      hiddenCategories: hiddenCategories.value,
      highlightRouteId: highlightedRouteId.value,
      selectedPoiId: selectedPoiId.value,
    }
  }

  /**
   * 丢掉已经失效的路段高亮。
   *
   * 渲染层只要看到「有高亮」就会把其余路线一起淡化，所以一旦这段路根本画不出来，
   * 屏幕上就是「一段都没亮、整张图的导航线却都变透明」。画不出来有四种情况：
   *   1. 改稿 / 重新规划路线 / 删掉节点后路线整体重建，id 已不存在；
   *   2. 它所在的天被隐藏了；
   *   3. 图例里把「导航路线」/「跨天转移」分类关掉了；
   *   4. 它是零距离小段，path 只有一个点，本来就不画。
   *
   * 这里把状态一并清掉，时间轴上「当前路段」的标记也就跟着复位，不会显示成还在高亮。
   */
  function pruneStaleHighlight(): void {
    const id = highlightedRouteId.value
    if (!id) return

    const route = guide.value?.routes.find((item) => item.id === id)
    if (!route) {
      highlightedRouteId.value = null
      return
    }

    const day = route.day_id ? guide.value?.days.find((item) => item.id === route.day_id) : null
    const dayHidden = !!day && hiddenDays.value.includes(day.day_index)
    const categoryHidden = hiddenCategories.value.includes(route.transfer ? 'transfer' : 'route')
    const tooShort = !Array.isArray(route.path) || route.path.length < 2

    if (dayHidden || categoryHidden || tooShort) highlightedRouteId.value = null
  }

  function applyRender(): void {
    pruneStaleHighlight()
    renderGuide(mapStore.viewer, guide.value, renderOptions())
  }

  /** 切换某一天的显隐，同时重绘地图 */
  function toggleDay(dayIndex: number): void {
    const index = hiddenDays.value.indexOf(dayIndex)
    if (index >= 0) hiddenDays.value.splice(index, 1)
    else hiddenDays.value.push(dayIndex)
  }

  /** 地图上显示全部行程天 */
  function showAllDays(): void {
    hiddenDays.value = []
  }

  /** 地图上隐藏全部行程天 */
  function hideAllDays(): void {
    hiddenDays.value = guide.value ? guide.value.days.map((day) => day.day_index) : []
  }

  /** 切换某个图例分类（图标类型 / 线类型）的显隐 */
  function toggleCategory(key: LegendKey): void {
    const index = hiddenCategories.value.indexOf(key)
    if (index >= 0) hiddenCategories.value.splice(index, 1)
    else hiddenCategories.value.push(key)
  }

  /** 显示全部类型 */
  function showAllCategories(): void {
    hiddenCategories.value = []
  }

  /** 隐藏当前攻略里存在的全部类型 */
  function hideAllCategories(): void {
    hiddenCategories.value = legendEntries.value.map((entry) => entry.item.key)
  }

  /** 一键：若已全部隐藏则全部显示，否则全部隐藏 */
  function toggleAllCategories(): void {
    if (allCategoriesHidden.value) showAllCategories()
    else hideAllCategories()
  }

  /** 某个节点是否被图例分类隐藏（详情弹窗据此同步收起） */
  function isPoiHidden(poi: GuidePoiDto): boolean {
    return hiddenCategories.value.includes(legendKeyOf(poi, startPoiId.value))
  }

  /**
   * 导出当前攻略为可下载的 HTML：
   * 截两张场景图（住宿 + 路线 / 起点 + 路线）→ 组装单文件 → 触发下载。
   * 截图一律带卫星底图，因此导出前临时切到卫星，导出后复原用户原本选的底图。
   */
  async function exportGuideHtml(): Promise<void> {
    const current = guide.value
    if (!current || exporting.value) return

    exporting.value = true
    error.value = null
    const previousBasemap = mapStore.activeBasemap
    try {
      mapStore.setBasemap('img')
      const maps = await captureRouteMaps(mapStore.viewer, current, renderOptions())
      downloadHtml(guideHtmlFileName(current), buildGuideHtml(current, maps))
    } catch (caught) {
      error.value = `导出失败：${(caught as Error).message}`
      pushLog('error', error.value)
    } finally {
      mapStore.setBasemap(previousBasemap)
      exporting.value = false
    }
  }

  /** 生成 / 改稿共用的流事件处理器（失败文案按操作区分，别一律说「生成失败」） */
  function makeStreamHandlers(doneStage: string, failStage: string): StreamHandlers {
    return {
      onStage: ({ message }) => {
        stage.value = message
        pushLog('stage', message)
      },
      onReasoning: ({ text }) => {
        appendReasoning(text)
      },
      onPoi: ({ done, total, name, status }) => {
        poiProgress.value = { done, total, current: name }
        const role = status === 'ok' || status === 'manual' ? 'ok' : status === 'skipped' ? 'stage' : 'warn'
        pushLog(role, `[${done}/${total}] ${name} — ${STATUS_LOG_TEXT[status] ?? status}`)
      },
      onResult: ({ guide: result, issues: resultIssues, stats }) => {
        guide.value = result
        issues.value = resultIssues
        stage.value = doneStage
        pushLog(
          'ok',
          `共 ${result.total_days} 天 / ${stats.totalNodes} 个节点，` +
            `落点成功 ${stats.okCount} 个，无需落点 ${stats.skippedCount} 个，` +
            `耗时 ${(stats.elapsedMs / 1000).toFixed(1)} 秒`,
        )
      },
      onError: ({ message }) => {
        error.value = message
        stage.value = failStage
        pushLog('error', message)
      },
    }
  }

  /** 处理流式过程中的异常（取消 / 失败）并复位生成状态 */
  function handleStreamError(caught: unknown, cancelText: string, failStage = '生成失败'): void {
    const err = caught as Error
    if (err.name === 'AbortError') {
      stage.value = '已取消'
      pushLog('warn', cancelText)
    } else {
      error.value = err.message
      stage.value = failStage
      pushLog('error', err.message)
    }
  }

  /**
   * 生成攻略前的澄清提问：先让 AI 反问几个关键问题。
   *
   * 返回问题列表供前端展示；用户答完后把答案拼进 prompt，再调 generate()。
   * 失败、取消或已有任务在跑时返回 null。
   */
  async function clarify(prompt: string): Promise<ClarifyQuestion[] | null> {
    if (clarifying.value || generating.value || routing.value) return null

    clarifying.value = true
    clarifyQuestions.value = []
    error.value = null
    reasoning.value = ''
    stage.value = '正在梳理还需要确认的信息…'
    logs.value = []
    pushLog('user', prompt)

    controller = new AbortController()
    let result: ClarifyQuestion[] | null = null

    try {
      await clarifyGuideStream(
        prompt,
        {
          onStage: ({ message }) => {
            stage.value = message
          },
          onReasoning: ({ text }) => {
            appendReasoning(text)
          },
          onClarify: ({ questions }) => {
            result = questions
            clarifyQuestions.value = questions
            pushLog('ok', `排行程前想先确认 ${questions.length} 件事`)
          },
          onError: ({ message }) => {
            error.value = message
            pushLog('error', message)
          },
        },
        controller.signal,
      )
    } catch (caught) {
      handleStreamError(caught, '已取消提问', '提问失败')
    } finally {
      clarifying.value = false
      controller = null
    }

    return result
  }

  /** 收起诉求澄清面板（保留用户已输入的内容由调用方处理） */
  function clearClarify(): void {
    clarifyQuestions.value = []
  }

  /** 一句话生成攻略（流式），完成后自动规划路线 */
  async function generate(prompt: string, options?: { days?: number; region?: string }): Promise<void> {
    if (generating.value) return

    // 留一份当前攻略：本次生成失败 / 被取消时要还回去，
    // 否则一次没跑成的生成会把用户正在看的攻略一起弄丢（数据库里还在，但界面空了）。
    const previous = guide.value

    generating.value = true
    error.value = null
    issues.value = []
    stage.value = '正在连接服务…'
    reasoning.value = ''
    poiProgress.value = { done: 0, total: 0, current: '' }
    clarifyQuestions.value = []
    hiddenDays.value = []
    hiddenCategories.value = []
    highlightedRouteId.value = null
    selectedPoiId.value = null
    logs.value = []
    // 清掉上一份结果，避免生成期间误渲染旧攻略
    guide.value = null
    clearGuideLayer(mapStore.viewer)

    pushLog('user', prompt)
    controller = new AbortController()

    try {
      await generateGuideStream(
        { prompt, days: options?.days, region: options?.region },
        makeStreamHandlers('攻略生成完成', '生成失败'),
        controller.signal,
      )
    } catch (caught) {
      handleStreamError(caught, '已取消生成', '生成失败')
    } finally {
      generating.value = false
      controller = null
    }

    if (!guide.value) {
      // 没拿到新结果：把原来那份放回去，至少别让界面变成空的
      if (previous) {
        guide.value = previous
        applyRender()
      }
      return
    }

    applyRender()
    flyToGuide(mapStore.viewer, guide.value)
    await planRoutes()
  }

  /**
   * AI 改稿：对「当前打开的攻略」按指令重写并回写数据库。
   * 成功后路线会整体重建，因此这里同样重新规划一次驾车路线。
   */
  async function revise(instruction: string): Promise<void> {
    const current = guide.value
    if (!current || generating.value || routing.value) return

    generating.value = true
    error.value = null
    issues.value = []
    stage.value = '正在准备改稿…'
    reasoning.value = ''
    poiProgress.value = { done: 0, total: 0, current: '' }
    hiddenDays.value = []
    hiddenCategories.value = []
    highlightedRouteId.value = null
    selectedPoiId.value = null

    pushLog('user', `改稿要求：${instruction}`)
    controller = new AbortController()

    try {
      await reviseGuideStream(
        current.id,
        instruction,
        makeStreamHandlers('改稿完成', '改稿失败'),
        controller.signal,
      )
    } catch (caught) {
      handleStreamError(caught, '已取消改稿', '改稿失败')
    } finally {
      generating.value = false
      controller = null
    }

    if (!guide.value) return

    applyRender()
    flyToGuide(mapStore.viewer, guide.value)
    await planRoutes()
  }

  /** 规划各天景点间的驾车路线，并刷新攻略数据 */
  async function planRoutes(): Promise<void> {
    if (!guide.value) return

    routing.value = true
    stage.value = '正在规划驾车路线…'
    pushLog('stage', '正在规划各天景点间的驾车路线…')

    try {
      const result = await planGuideRoute(guide.value.id)
      const refreshed = await getGuide(guide.value.id)
      guide.value = refreshed
      applyRender()
      pushLog(
        'ok',
        `路线规划完成：${result.legCount} 段，总里程 ${(result.totalDistanceM / 1000).toFixed(1)} km`,
      )
      if (result.skipped.length > 0) {
        pushLog('warn', `${result.skipped.length} 段路线规划失败`)
      }
      stage.value = '全部完成'
    } catch (caught) {
      const err = caught as Error
      pushLog('error', `路线规划失败：${err.message}`)
      stage.value = '路线规划失败'
    } finally {
      routing.value = false
    }
  }

  /** 取消进行中的生成 */
  function cancel(): void {
    controller?.abort()
  }

  /**
   * 时间轴编辑后的「保存 + 让 AI 重新规划」。
   *
   * 三步串行：
   *   1. 把编辑后的整条时间轴写回数据库（PUT /api/guide/:id）
   *   2. 让 AI 重新编排各节点的顺序 / 所属天 / 到达时间
   *      —— 只重排导航，不新增也不删除任何节点
   *   3. 按新顺序重新规划驾车路线，并用真实里程 / 耗时刷新时间轴
   */
  async function saveTimelineAndReplan(payload: GuideSavePayload): Promise<boolean> {
    const current = guide.value
    if (!current || savingTimeline.value || generating.value || routing.value) return false

    savingTimeline.value = true
    error.value = null
    reasoning.value = ''
    stage.value = '正在保存时间轴…'
    highlightedRouteId.value = null
    selectedPoiId.value = null
    pushLog('stage', '正在保存时间轴改动…')

    // 保存与 AI 重排是两件不同的事，出错时文案要指到真正失败的那一步
    let phase: 'save' | 'replan' = 'save'

    try {
      // 先和保存前的数据比一遍：只重排「这次真正改了的那几天」，
      // 其余天原样保留（换了出发 / 住宿地时，前后一天也会被带上）
      const affectedDays = diffAffectedDays(current, payload)

      const saved = await saveGuide(current.id, payload)
      guide.value = saved
      applyRender()
      pushLog('ok', '时间轴已保存')

      phase = 'replan'
      if (affectedDays.length === 0) {
        pushLog('stage', '时间轴没有结构性改动，跳过 AI 重排')
      } else {
        stage.value = `正在让 AI 重新编排第 ${affectedDays.join('、')} 天…`
        pushLog('stage', `只重排被改动的第 ${affectedDays.join('、')} 天，其余天保持不变`)
        await replanGuideStream(
          current.id,
          {
            onStage: ({ message }) => {
              stage.value = message
              pushLog('stage', message)
            },
            onReasoning: ({ text }) => {
              appendReasoning(text)
            },
            onReplan: ({ guide: replanned, summary }) => {
              guide.value = replanned
              const parts = [
                summary.movedDays > 0 ? `${summary.movedDays} 个节点换了天` : '',
                summary.reordered > 0 ? `${summary.reordered} 个节点调整了顺序` : '',
                summary.retimed > 0 ? `${summary.retimed} 个节点时间更新` : '',
                summary.filled > 0 ? `${summary.filled} 个新节点补上了游玩时长` : '',
              ].filter(Boolean)
              pushLog(
                'ok',
                parts.length > 0
                  ? `AI 重排完成：${parts.join('，')}（共 ${summary.total} 个节点）`
                  : `AI 重排完成：${summary.total} 个节点顺序已是最优`,
              )
            },
            onError: ({ message }) => {
              error.value = message
              stage.value = '重排失败'
              pushLog('error', `重排失败：${message}`)
            },
          },
          undefined,
          affectedDays,
        )
      }

      if (error.value) return false

      applyRender()
      await planRoutes()
      return true
    } catch (caught) {
      const err = caught as Error
      const label = phase === 'replan' ? '重排失败' : '保存失败'
      if (err.name === 'AbortError') {
        stage.value = '已取消'
        pushLog('warn', phase === 'replan' ? '已取消重新规划' : '已取消保存时间轴')
      } else {
        error.value = err.message
        stage.value = label
        pushLog('error', `${label}：${err.message}`)
      }
      return false
    } finally {
      savingTimeline.value = false
    }
  }

  /** 载入已有攻略 */
  async function loadGuide(id: string): Promise<void> {
    error.value = null
    const loaded = await getGuide(id)
    guide.value = loaded
    hiddenDays.value = []
    hiddenCategories.value = []
    highlightedRouteId.value = null
    selectedPoiId.value = null
    logs.value = []
    pushLog('ok', `已载入攻略：${loaded.title}`)

    // 数据已经到手，后面的渲染 / 取景只是「附加动作」：出错就记一条日志，
    // 不要往上抛 —— 否则调用方（资源库的「打开」）会把用户直接退回列表，
    // 看起来就像「点了没反应 / 不跳转」。
    try {
      applyRender()
      flyToGuide(mapStore.viewer, loaded)
    } catch (caught) {
      pushLog('warn', `地图渲染失败：${(caught as Error).message}`)
    }

    // 老数据可能还没算过跨天转移路段，补算一次，保证地图上路线连续
    if (loaded.days.length > 1 && !loaded.routes.some((route) => route.transfer)) {
      pushLog('stage', '正在补算跨天转移路段…')
      await planRoutes()
    }
  }

  /** 直接替换当前攻略（编辑器保存后回填，避免重复请求） */
  function setGuide(dto: GuideDto | null): void {
    guide.value = dto
    if (!dto) {
      clearGuideLayer(mapStore.viewer)
      return
    }
    // 天可能被删除，过滤掉已不存在的隐藏天
    hiddenDays.value = hiddenDays.value.filter((index) =>
      dto.days.some((day) => day.day_index === index),
    )
    applyRender()
    flyToGuide(mapStore.viewer, dto)
  }

  /** 清空当前攻略 */
  function reset(): void {
    guide.value = null
    issues.value = []
    logs.value = []
    hiddenDays.value = []
    hiddenCategories.value = []
    highlightedRouteId.value = null
    selectedPoiId.value = null
    error.value = null
    stage.value = ''
    reasoning.value = ''
    clearGuideLayer(mapStore.viewer)
  }

  /**
   * 找出某个节点对应的驾车路段。
   *
   * 「赶路」节点本身没有坐标，它夹在前后两个可落点节点之间，
   * 因此取该天中它前面最近、后面最近的两个有坐标节点，其间的 route 即为这段路程。
   */
  function findRouteForNode(node: GuidePoiDto): GuideRouteDto | null {
    const current = guide.value
    if (!current) return null

    const day = current.days.find((item) => item.id === node.day_id)
    if (!day) return null

    const index = day.pois.findIndex((item) => item.id === node.id)
    if (index < 0) return null

    const hasCoord = (item: GuidePoiDto) => item.lng !== null && item.lat !== null
    let fromId: string | null = null
    let toId: string | null = null

    for (let i = index - 1; i >= 0; i -= 1) {
      if (hasCoord(day.pois[i])) {
        fromId = day.pois[i].id
        break
      }
    }
    for (let i = index + 1; i < day.pois.length; i += 1) {
      if (hasCoord(day.pois[i])) {
        toId = day.pois[i].id
        break
      }
    }
    if (!fromId || !toId) return null

    return (
      current.routes.find((route) => route.from_poi_id === fromId && route.to_poi_id === toId) ?? null
    )
  }

  /** 找出「到达某个节点」的那一段路（时间轴上车辆图标对应的就是它） */
  function findRouteTo(node: GuidePoiDto): GuideRouteDto | null {
    const current = guide.value
    if (!current) return null
    return (
      current.routes.find((route) => route.to_poi_id === node.id && !route.transfer) ?? null
    )
  }

  /** 高亮某一段路并飞到它的范围（时间轴上点车辆图标用） */
  function focusRoute(route: GuideRouteDto): void {
    const day = guide.value?.days.find((item) => item.id === route.day_id)
    if (day && hiddenDays.value.includes(day.day_index)) toggleDay(day.day_index)

    selectedPoiId.value = null
    highlightedRouteId.value = route.id
    applyRender()
    flyToRoute(mapStore.viewer, route)
  }

  /**
   * 选中某个节点：地图上的图标与时间轴上的节点行两边同时高亮。
   *
   * 注意这里**不动**路段高亮（点图标只看地点，路程高亮交给时间轴上的车辆图标）。
   */
  function selectPoi(poiId: string): void {
    if (selectedPoiId.value === poiId) return
    selectedPoiId.value = poiId
    highlightedRouteId.value = null
    applyRender()
  }

  /**
   * 时间轴上点击某个节点：
   * - 普通地点 → 选中它并把相机飞过去
   * - 赶路节点（本身没有坐标）→ 选中并飞到它对应的那段驾车路线
   */
  function focusNode(node: GuidePoiDto): void {
    const day = guide.value?.days.find((item) => item.id === node.day_id)
    if (day && hiddenDays.value.includes(day.day_index)) toggleDay(day.day_index)

    selectedPoiId.value = node.id
    highlightedRouteId.value = null
    applyRender()

    if (node.lng !== null && node.lat !== null) {
      flyToPoi(mapStore.viewer, node)
      return
    }
    // 赶路节点自己没有坐标，用前后两个可落点节点夹出的那一段
    const route = findRouteForNode(node)
    if (route) flyToRoute(mapStore.viewer, route)
  }

  /** 清除路线高亮 */
  function clearHighlight(): void {
    if (!highlightedRouteId.value) return
    highlightedRouteId.value = null
    applyRender()
  }

  // 天显隐变化时重绘
  watch(hiddenDays, applyRender, { deep: true })

  // 图例分类显隐变化时重绘
  watch(hiddenCategories, applyRender, { deep: true })

  // Viewer 重建后（如热更新）重新挂载图层
  watch(
    () => mapStore.isReady,
    (ready) => {
      if (ready && guide.value) applyRender()
    },
  )

  return {
    guide,
    issues,
    generating,
    routing,
    clarifying,
    busy,
    elapsedSec,
    clarifyQuestions,
    stage,
    reasoning,
    poiProgress,
    error,
    logs,
    exporting,
    savingTimeline,
    hiddenDays,
    hiddenCategories,
    startPoiId,
    legendEntries,
    allCategoriesHidden,
    highlightedRouteId,
    selectedPoiId,
    generate,
    revise,
    planRoutes,
    saveTimelineAndReplan,
    cancel,
    clarify,
    clearClarify,
    loadGuide,
    setGuide,
    reset,
    toggleDay,
    showAllDays,
    hideAllDays,
    toggleCategory,
    showAllCategories,
    hideAllCategories,
    toggleAllCategories,
    isPoiHidden,
    exportGuideHtml,
    focusNode,
    focusRoute,
    selectPoi,
    clearHighlight,
    findRouteForNode,
    findRouteTo,
  }
})

/**
 * 开发期热更新：Pinia 的 store 实例按 id 缓存，改完 store / 渲染层后若走了
 * 局部 HMR，旧实例会缺少新增的 action 与 computed，表现为「点图例没反应」。
 * 显式接管更新，重建 store 实现而不是留一个半旧的实例。
 */
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGuideStore, import.meta.hot))
}
