<script setup lang="ts">
import { computed } from 'vue'
import * as Cesium from 'cesium'
import { useMapStore } from '@/stores/map'

const mapStore = useMapStore()

const coordText = computed(() => {
  const geo = mapStore.mouseGeo
  if (!geo) return '经纬度 -- , --'
  return `经度 ${geo.lng.toFixed(6)}°　纬度 ${geo.lat.toFixed(6)}°`
})

const heightText = computed(() => {
  const height = mapStore.cameraHeight
  if (!height) return '视高 --'
  if (height >= 1000) return `视高 ${(height / 1000).toFixed(1)} km`
  return `视高 ${height.toFixed(0)} m`
})

const sceneModeText = computed(() => {
  const mode = mapStore.viewer?.scene.mode
  if (mode === Cesium.SceneMode.SCENE2D) return '2D 平面'
  if (mode === Cesium.SceneMode.COLUMBUS_VIEW) return '2.5D'
  if (mode === undefined) return '--'
  return '3D 球面'
})

/** Cesium 版本号（构建产物运行时注入，类型声明中未导出，故做安全取值） */
const cesiumVersion = (Cesium as unknown as { VERSION?: string }).VERSION ?? '--'
</script>

<template>
  <footer class="app-status">
    <span class="app-status__item">
      <i class="app-status__dot" :class="{ 'is-live': !!mapStore.mouseGeo }" />
      {{ coordText }}
    </span>

    <span class="app-status__item">{{ heightText }}</span>

    <span class="app-status__spacer" />

    <span class="app-status__item">场景 {{ sceneModeText }}</span>
    <span class="app-status__item">FPS {{ mapStore.fps }}</span>
    <span class="app-status__item">Cesium {{ cesiumVersion }}</span>
  </footer>
</template>

<style scoped>
.app-status {
  display: flex;
  align-items: center;
  gap: 18px;
  flex: 0 0 var(--status-h);
  height: var(--status-h);
  padding: 0 14px;
  border-top: 1px solid var(--border);
  background: #fbfcfe;
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.app-status__item {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.app-status__spacer {
  flex: 1;
}

.app-status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.app-status__dot.is-live {
  background: var(--success);
}
</style>
