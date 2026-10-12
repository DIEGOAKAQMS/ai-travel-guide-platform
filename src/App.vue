<script setup lang="ts">
import AppHeader from '@/components/layout/AppHeader.vue'
import AppStatusBar from '@/components/layout/AppStatusBar.vue'
import CesiumViewer from '@/components/map/CesiumViewer.vue'
import MapLegend from '@/components/map/MapLegend.vue'
import MapModeSwitcher from '@/components/map/MapModeSwitcher.vue'
import GuideTimeline from '@/components/panel/GuideTimeline.vue'
import AiAssistant from '@/components/ai/AiAssistant.vue'
import GuideLibrary from '@/components/library/GuideLibrary.vue'
import GuideEditor from '@/components/library/GuideEditor.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="app-shell">
    <AppHeader />

    <main class="map-stage">
      <!-- 地图始终保持挂载：切换到攻略库或地图拾取坐标时都不用重建 Cesium -->
      <CesiumViewer />

      <template v-if="ui.activeView === 'map'">
        <!-- 左侧：行程时间轴（每天的显隐在时间轴里控制） -->
        <div class="map-side">
          <GuideTimeline />
        </div>

        <!-- 右上角：图例（按类型控制图上点线的显隐） -->
        <div class="map-legend">
          <MapLegend />
        </div>

        <!-- 右下角：地图模式切换 + AI 横条 -->
        <div class="map-dock">
          <MapModeSwitcher />
          <AiAssistant />
        </div>
      </template>

      <!-- 资源库：攻略管理（覆盖在地图之上，保持地图存活） -->
      <GuideLibrary v-else />

      <!-- 地图拾取坐标提示 -->
      <div v-if="ui.pickingPoiKey" class="pick-hint">
        <span class="pick-hint__text">在图上点击，为「{{ ui.pickingPoiName }}」拾取坐标</span>
        <button type="button" class="pick-hint__cancel" @click="ui.cancelPicking()">取消</button>
      </div>
    </main>

    <AppStatusBar />

    <!-- 攻略编辑器（全屏弹层，随视图独立于地图之上） -->
    <GuideEditor v-if="ui.editorOpen && ui.draft" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}

.map-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 左侧一列：行程时间轴 */
.map-side {
  position: absolute;
  top: 14px;
  left: 14px;
  bottom: 14px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  width: 352px;
  /* 容器本身不挡地图点击，只有子面板可交互 */
  pointer-events: none;
}

.map-side > * {
  pointer-events: auto;
}

/* 右上角：图例 */
.map-legend {
  position: absolute;
  top: 14px;
  right: 14px;
  bottom: 14px;
  z-index: 13;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  /* 容器本身不挡地图点击，只有面板可交互 */
  pointer-events: none;
}

.map-legend > * {
  pointer-events: auto;
}

.map-dock {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 12;
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

/* 地图拾取坐标提示 */
.pick-hint {
  position: absolute;
  top: 14px;
  left: 50%;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--panel-bg);
  color: var(--text-1);
  font-size: 12px;
  box-shadow: var(--panel-shadow);
  transform: translateX(-50%);
  /* 提示本身不挡地图点击，只有「取消」可交互 */
  pointer-events: none;
}

.pick-hint__cancel {
  color: var(--text-3);
  font-size: 12px;
  pointer-events: auto;
}

.pick-hint__cancel:hover {
  color: var(--danger);
}
</style>
