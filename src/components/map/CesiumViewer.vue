<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import PoiPopup from './PoiPopup.vue'
import { useMapStore } from '@/stores/map'
import { useGuideStore } from '@/stores/guide'
import { useUiStore } from '@/stores/ui'
import type { TerrainMode } from '@/stores/map'
import {
  ARCGIS_TERRAIN_URL,
  CESIUM_ION_TOKEN,
  TERRAIN_ENABLED,
  TERRAIN_TYPE,
  TERRAIN_URL,
  hasTiandituToken,
} from '@/config'
import { validateTiandituToken } from '@/services/tianditu'

const container = ref<HTMLDivElement | null>(null)
const mapStore = useMapStore()
const guideStore = useGuideStore()
const ui = useUiStore()

let viewer: Cesium.Viewer | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null
let removePostRender: (() => void) | null = null
let removePopupTracking: (() => void) | null = null

/** 详情弹窗的屏幕位置（每帧由 Cesium 投影算出） */
const popupPos = ref<{ x: number; y: number } | null>(null)

/** 弹窗宽度（与 PoiPopup 的 width 对应），用于横向防溢出 */
const POPUP_WIDTH = 340
/** 弹窗还没量到高度时的估值（之后由 PoiPopup 通过 resize 事件报真实高度） */
const POPUP_EST_HEIGHT = 420
/** 弹窗与标记之间的竖直间距（要与 PoiPopup 里的 transform 对应） */
const POPUP_GAP_ABOVE = 74
const POPUP_GAP_BELOW = 28
/** 贴边的安全边距 */
const POPUP_MARGIN = 8

/** 画布高度（每帧更新，用于判断弹窗放上方还是下方） */
const canvasHeight = ref(0)
/** 弹窗真实高度（PoiPopup 的 resize 事件） */
const popupHeight = ref(0)

/** 当前弹窗对应的节点坐标（天/类型被隐藏或节点无坐标时为 null） */
const popupTarget = computed(() => {
  const id = ui.poiPopupId
  const guide = guideStore.guide
  if (!id || !guide) return null
  for (const day of guide.days) {
    const poi = day.pois.find((item) => item.id === id)
    if (!poi) continue
    if (poi.lng === null || poi.lat === null) return null
    if (guideStore.hiddenDays.includes(day.day_index)) return null
    // 图例里把该类型隐藏后，贴着它的详情弹窗也要一起收起
    if (guideStore.isPoiHidden(poi)) return null
    return { lng: poi.lng, lat: poi.lat }
  }
  return null
})

/**
 * 弹窗放标记上方还是下方。
 *
 * 便签高度随内容（有没有实景图、详细介绍多长）变化，所以按**真实高度**判断：
 * 上方放得下就放上方，否则看下方，两边都放不下时取空间大的一侧。
 */
const popupPlacement = computed<'top' | 'bottom'>(() => {
  const pos = popupPos.value
  if (!pos) return 'top'
  const height = popupHeight.value > 0 ? popupHeight.value : POPUP_EST_HEIGHT
  const fitsAbove = pos.y - POPUP_GAP_ABOVE - height >= POPUP_MARGIN
  if (fitsAbove) return 'top'
  const fitsBelow =
    pos.y + POPUP_GAP_BELOW + height <= (canvasHeight.value || Number.POSITIVE_INFINITY) - POPUP_MARGIN
  if (fitsBelow) return 'bottom'
  return pos.y > canvasHeight.value / 2 ? 'top' : 'bottom'
})

/** 初始化场景外观：去掉 Cesium 默认 UI，配色与浅色主题保持一致 */
function setupScene(instance: Cesium.Viewer) {
  const scene = instance.scene

  scene.globe.baseColor = Cesium.Color.fromCssColorString('#dfe8f4')
  scene.globe.depthTestAgainstTerrain = false
  scene.fog.enabled = true
  scene.postProcessStages.fxaa.enabled = true
  scene.backgroundColor = Cesium.Color.fromCssColorString('#eef2f8')
  scene.globe.showGroundAtmosphere = true

  // 大气层 / 光照（部分场景对象可能未启用，需判空）
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true
  }
  if (scene.sun) {
    scene.sun.show = true
  }
  if (scene.moon) {
    scene.moon.show = false
  }
}

/**
 * 应用地形 Provider。
 *
 * 地形只用来表现起伏，**不参与深度测试**：开启后山体会把贴地的路线与箭头挡掉
 * （`GroundPolyline` 会与地形做深度比较），路线指引就断了。关掉后山照常渲染，
 * 只是不再遮挡路线；图标与标注走独立集合且层级更高，不受影响。
 */
function applyTerrainProvider(
  instance: Cesium.Viewer,
  provider: Cesium.TerrainProvider,
  mode: TerrainMode,
) {
  instance.scene.terrainProvider = provider
  instance.scene.globe.depthTestAgainstTerrain = false
  mapStore.setTerrainMode(mode)
}

/**
 * 加载真实高程地形，优先级：
 * 1. 自定义地形服务（VITE_TERRAIN_URL，支持 quantized-mesh / ArcGIS）
 * 2. Cesium Ion World Terrain（VITE_CESIUM_ION_TOKEN）
 * 3. 免 token 的公共 ArcGIS World Elevation 3D
 * 全部失败则回退为光滑椭球面。
 */
async function setupTerrain(instance: Cesium.Viewer) {
  if (!TERRAIN_ENABLED) {
    mapStore.setTerrainMode('flat')
    return
  }

  try {
    if (TERRAIN_URL) {
      if (TERRAIN_TYPE === 'arcgis') {
        const provider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL)
        applyTerrainProvider(instance, provider, 'custom')
      } else {
        const provider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL)
        applyTerrainProvider(instance, provider, 'custom')
      }
      return
    }

    if (CESIUM_ION_TOKEN) {
      const terrain = await Cesium.Terrain.fromWorldTerrain()
      instance.scene.setTerrain(terrain)
      // 同 applyTerrainProvider：地形不遮挡贴地路线与箭头
      instance.scene.globe.depthTestAgainstTerrain = false
      mapStore.setTerrainMode('ion')
      return
    }

    const provider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ARCGIS_TERRAIN_URL)
    applyTerrainProvider(instance, provider, 'arcgis')
  } catch (error) {
    console.warn('[CesiumViewer] 高程地形加载失败，已回退为光滑椭球面：', error)
    mapStore.setTerrainMode('flat')
  }
}

/** 屏幕坐标 → 地表经纬度（优先贴地取点，失败退回椭球面） */
function pickGround(
  instance: Cesium.Viewer,
  position: Cesium.Cartesian2,
): { lng: number; lat: number } | null {
  const scene = instance.scene
  const ray = instance.camera.getPickRay(position)
  let cartesian: Cesium.Cartesian3 | undefined
  if (ray) {
    cartesian = scene.globe.pick(ray, scene) ?? undefined
  }
  if (!cartesian) {
    cartesian = instance.camera.pickEllipsoid(position, scene.globe.ellipsoid) ?? undefined
  }
  if (!cartesian) return null
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
  return {
    lng: Cesium.Math.toDegrees(cartographic.longitude),
    lat: Cesium.Math.toDegrees(cartographic.latitude),
  }
}

/** 点击地图：拾取坐标模式优先回填，否则点击景点图标 → 通知时间轴高亮对应节点 */
function setupPicking(instance: Cesium.Viewer) {
  handler?.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    // 编辑器「地图拾取坐标」模式：把点击位置回填给正在编辑的节点
    if (ui.pickingPoiKey) {
      const ground = pickGround(instance, movement.position)
      if (ground) ui.applyPicked(ground.lng, ground.lat)
      return
    }

    const picked = instance.scene.pick(movement.position) as { id?: unknown } | undefined
    const entity = picked?.id as Cesium.Entity | undefined
    // 攻略点位实体的 id 形如 `poi:<uuid>`
    if (!entity || typeof entity.id !== 'string' || !entity.id.startsWith('poi:')) {
      // 点到空白处 / 路线：收起详情弹窗，并清掉时间轴上的路段高亮
      ui.closePoiPopup()
      guideStore.clearHighlight()
      return
    }

    const poiId = entity.id.slice(4)
    // 时间轴同步高亮 + 打开景点详情弹窗
    guideStore.selectPoi(poiId)
    ui.openPoiPopup(poiId)
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
}

/** 每帧把弹窗对应景点的经纬度投影成屏幕坐标，让弹窗贴着标记走 */
function setupPopupTracking(instance: Cesium.Viewer) {
  const toCamera = new Cesium.Cartesian3()
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    instance.camera.positionWC,
  )

  const update = () => {
    const height = instance.scene.canvas.clientHeight
    if (height !== canvasHeight.value) canvasHeight.value = height

    const target = popupTarget.value
    if (!target) {
      if (popupPos.value) popupPos.value = null
      return
    }

    const position = Cesium.Cartesian3.fromDegrees(target.lng, target.lat)
    const camera = instance.camera

    // 位于相机背后 → 不显示
    Cesium.Cartesian3.subtract(position, camera.positionWC, toCamera)
    if (Cesium.Cartesian3.dot(camera.directionWC, toCamera) <= 0) {
      if (popupPos.value) popupPos.value = null
      return
    }

    // 被地球遮挡（转到球背面）→ 不显示
    occluder.cameraPosition = camera.positionWC
    if (!occluder.isPointVisible(position)) {
      if (popupPos.value) popupPos.value = null
      return
    }

    const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(instance.scene, position)
    if (!windowPos) {
      if (popupPos.value) popupPos.value = null
      return
    }

    // 横向夹紧，避免弹窗被视口边缘裁掉
    const half = POPUP_WIDTH / 2
    const minX = half + 6
    const maxX = Math.max(minX, instance.scene.canvas.clientWidth - half - 6)
    const x = Math.min(Math.max(windowPos.x, minX), maxX)
    const y = windowPos.y

    const current = popupPos.value
    if (current && Math.abs(current.x - x) < 0.5 && Math.abs(current.y - y) < 0.5) return
    popupPos.value = { x, y }
  }

  removePopupTracking = instance.scene.postRender.addEventListener(update)
}

/** 鼠标经纬度拾取 */
function setupMouseTracking(instance: Cesium.Viewer) {
  const scene = instance.scene
  handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)

  handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    const ray = instance.camera.getPickRay(movement.endPosition)
    let cartesian: Cesium.Cartesian3 | undefined
    if (ray) {
      cartesian = scene.globe.pick(ray, scene) ?? undefined
    }
    if (!cartesian) {
      cartesian = instance.camera.pickEllipsoid(movement.endPosition, scene.globe.ellipsoid) ?? undefined
    }
    if (!cartesian) {
      mapStore.mouseGeo = null
      return
    }
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
    mapStore.mouseGeo = {
      lng: Cesium.Math.toDegrees(cartographic.longitude),
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
}

/** 帧率 / 相机高度采样 */
function setupStats(instance: Cesium.Viewer) {
  let frames = 0
  let last = performance.now()

  removePostRender = instance.scene.postRender.addEventListener(() => {
    frames += 1
    const now = performance.now()
    const elapsed = now - last
    if (elapsed >= 1000) {
      mapStore.fps = Math.round((frames * 1000) / elapsed)
      mapStore.cameraHeight = instance.camera.positionCartographic.height
      frames = 0
      last = now
    }
  })
}

/** Esc：依次取消地图拾取坐标 → 关闭景点详情弹窗 → 清除时间轴上的路段高亮 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (ui.pickingPoiKey) {
    ui.cancelPicking()
    return
  }
  if (ui.poiPopupId) {
    ui.closePoiPopup()
    return
  }
  guideStore.clearHighlight()
}

onMounted(async () => {
  if (!container.value) return

  window.addEventListener('keydown', onKeydown)

  if (CESIUM_ION_TOKEN) {
    Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN
  }

  viewer = new Cesium.Viewer(container.value, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // 关闭默认 Cesium Ion 底图，改由天地图接管
    baseLayer: false,
    // 将版权信息渲染到游离节点，避免遮挡界面
    creditContainer: document.createElement('div'),
    contextOptions: {
      // preserveDrawingBuffer：导出攻略时要读回 canvas 像素（否则截图是空白）
      webgl: { alpha: false, antialias: true, preserveDrawingBuffer: true },
    },
  })

  setupScene(viewer)
  setupMouseTracking(viewer)
  setupPicking(viewer)
  setupStats(viewer)
  setupPopupTracking(viewer)

  mapStore.attachViewer(viewer)

  void setupTerrain(viewer)

  if (hasTiandituToken()) {
    validateTiandituToken().then((valid) => {
      mapStore.tokenValid = valid
    })
  } else {
    mapStore.tokenValid = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  handler?.destroy()
  handler = null
  removePostRender?.()
  removePostRender = null
  removePopupTracking?.()
  removePopupTracking = null
  popupPos.value = null
  mapStore.detachViewer()
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy()
  }
  viewer = null
})
</script>

<template>
  <div class="cesium-viewer">
    <div ref="container" class="cesium-viewer__canvas" />

    <!-- 景点详情弹窗：位置由 Cesium 每帧投影算出，跟随标记移动 -->
    <PoiPopup
      v-if="ui.poiPopupId && popupPos"
      :x="popupPos.x"
      :y="popupPos.y"
      :placement="popupPlacement"
      @resize="popupHeight = $event"
    />

    <div v-if="!hasTiandituToken()" class="cesium-viewer__alert">
      未检测到天地图 token，请在项目根目录 <code>.env</code> 中配置
      <code>VITE_TIANDITU_TOKEN</code> 后重启开发服务。
    </div>
  </div>
</template>

<style scoped>
.cesium-viewer,
.cesium-viewer__canvas {
  position: absolute;
  inset: 0;
}

.cesium-viewer__alert {
  position: absolute;
  top: 16px;
  left: 50%;
  z-index: 20;
  transform: translateX(-50%);
  padding: 8px 16px;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  background: #fff8e8;
  color: #a96600;
  font-size: 12px;
  box-shadow: var(--panel-shadow);
}

.cesium-viewer__alert code {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(217, 134, 0, 0.12);
}
</style>
