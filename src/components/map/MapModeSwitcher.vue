<script setup lang="ts">
import { BASEMAPS } from '@/config/basemaps'
import { useMapStore } from '@/stores/map'

const mapStore = useMapStore()
</script>

<template>
  <div class="map-mode">
    <button
      v-for="item in BASEMAPS"
      :key="item.key"
      class="map-mode__btn"
      :class="{ 'is-active': mapStore.activeBasemap === item.key }"
      type="button"
      :title="`切换到${item.name}地图`"
      @click="mapStore.setBasemap(item.key)"
    >
      <span class="map-mode__swatch" :style="{ background: item.swatch }" />
      <span class="map-mode__name">{{ item.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.map-mode {
  display: flex;
  gap: 4px;
  padding: 5px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--panel-bg);
  backdrop-filter: blur(8px);
  box-shadow: var(--panel-shadow);
}

.map-mode__btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  border-radius: 5px;
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
  transition: all 0.15s;
}

.map-mode__btn:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.map-mode__btn.is-active {
  background: var(--accent);
  color: #fff;
}

.map-mode__swatch {
  width: 12px;
  height: 12px;
  border: 1px solid rgba(23, 43, 77, 0.2);
  border-radius: 3px;
}

.map-mode__btn:not(.is-active) .map-mode__swatch {
  opacity: 0.75;
}
</style>
