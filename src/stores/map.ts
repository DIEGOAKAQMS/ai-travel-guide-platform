import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import { BASEMAPS } from '@/config/basemaps'
import { createTiandituProvider } from '@/services/tianditu'
import { HOME_VIEW } from '@/config'

export interface MouseGeoInfo {
  lng: number
  lat: number
  height: number
}

export type TerrainMode = 'flat' | 'ion' | 'arcgis' | 'custom'

export const useMapStore = defineStore('map', () => {
  // ===== 响应式状态 =====
  /** Cesium Viewer 实例（shallowRef：避免 Vue 深度代理 Cesium 对象） */
  const viewer = shallowRef<Cesium.Viewer | null>(null)
  const isReady = ref(false)

  /** 当前地图模式：img 卫星 / ter 高程 / vec 矢量 */
  const activeBasemap = ref(BASEMAPS[0].key)

  /** 状态栏数据 */
  const mouseGeo = ref<MouseGeoInfo | null>(null)
  const cameraHeight = ref(0)
  const fps = ref(0)

  /** 高程地形模式；token 校验结果 */
  const terrainMode = ref<TerrainMode>('flat')
  const tokenValid = ref<boolean | null>(null)

  // ===== 非响应式：Cesium 资源引用 =====
  let baseLayer: Cesium.ImageryLayer | null = null
  let labelLayer: Cesium.ImageryLayer | null = null

  /** 依据当前 activeBasemap 重建「底图 + 注记」图层 */
  function syncBasemap() {
    const instance = viewer.value
    if (!instance) return

    const preset = BASEMAPS.find((item) => item.key === activeBasemap.value)
    if (!preset) return

    if (baseLayer) {
      instance.imageryLayers.remove(baseLayer, true)
      baseLayer = null
    }
    if (labelLayer) {
      instance.imageryLayers.remove(labelLayer, true)
      labelLayer = null
    }

    baseLayer = instance.imageryLayers.addImageryProvider(createTiandituProvider(preset.base), 0)

    if (preset.label) {
      labelLayer = instance.imageryLayers.addImageryProvider(createTiandituProvider(preset.label), 1)
    }
  }

  // ===== actions =====
  /** Viewer 创建完成后注入 */
  function attachViewer(instance: Cesium.Viewer) {
    viewer.value = instance
    isReady.value = true
    syncBasemap()
    flyToHome()
  }

  /** Viewer 销毁前解绑 */
  function detachViewer() {
    baseLayer = null
    labelLayer = null
    viewer.value = null
    isReady.value = false
    mouseGeo.value = null
    cameraHeight.value = 0
    fps.value = 0
  }

  /** 切换地图模式：img / ter / vec */
  function setBasemap(key: string) {
    if (activeBasemap.value === key) return
    activeBasemap.value = key
    syncBasemap()
  }

  /** 复位到初始视角（四川省全境） */
  function flyToHome(duration = 1.2) {
    const instance = viewer.value
    if (!instance) return
    instance.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(HOME_VIEW.longitude, HOME_VIEW.latitude, HOME_VIEW.height),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration,
    })
  }

  /** 飞到指定经纬度 */
  function flyTo(lng: number, lat: number, height = 60000, duration = 1.5) {
    const instance = viewer.value
    if (!instance) return
    instance.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
      duration,
    })
  }

  /** 缩放：factor > 0 拉近，< 0 拉远 */
  function zoom(factor: number) {
    const instance = viewer.value
    if (!instance) return
    const amount = instance.camera.positionCartographic.height * factor
    if (factor > 0) instance.camera.zoomIn(amount)
    else instance.camera.zoomOut(Math.abs(amount))
  }

  /** 2D / 3D 场景切换 */
  function toggleSceneMode() {
    const instance = viewer.value
    if (!instance) return
    const is3D = instance.scene.mode === Cesium.SceneMode.SCENE3D
    if (is3D) {
      instance.scene.morphTo2D(1.0)
    } else {
      instance.scene.morphTo3D(1.0)
    }
  }

  /** 记录地形加载结果 */
  function setTerrainMode(mode: TerrainMode) {
    terrainMode.value = mode
  }

  return {
    // state
    viewer,
    isReady,
    activeBasemap,
    mouseGeo,
    cameraHeight,
    fps,
    terrainMode,
    tokenValid,
    // actions
    attachViewer,
    detachViewer,
    setBasemap,
    flyToHome,
    flyTo,
    zoom,
    toggleSceneMode,
    setTerrainMode,
  }
})
