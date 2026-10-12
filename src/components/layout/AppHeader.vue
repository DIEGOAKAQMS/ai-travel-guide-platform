<script setup lang="ts">
import { computed } from 'vue'
import { useGuideStore } from '@/stores/guide'
import { useMapStore } from '@/stores/map'
import { useUiStore, type ShellView } from '@/stores/ui'

const mapStore = useMapStore()
const ui = useUiStore()
const guideStore = useGuideStore()

interface NavItem {
  key: ShellView | 'dashboard'
  label: string
  enabled: boolean
}

const NAV: NavItem[] = [
  { key: 'map', label: '地图工作台', enabled: true },
  { key: 'library', label: '资源库', enabled: true },
  { key: 'dashboard', label: '数据看板', enabled: false },
]

const tokenText = computed(() => {
  if (mapStore.tokenValid === null) return '校验中'
  return mapStore.tokenValid ? '服务正常' : '服务异常'
})

const tokenClass = computed(() => {
  if (mapStore.tokenValid === null) return 'is-pending'
  return mapStore.tokenValid ? 'is-ok' : 'is-error'
})

function go(item: NavItem): void {
  if (!item.enabled) return
  ui.setView(item.key as ShellView)
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__brand">
      <span class="app-header__logo">T</span>
      <div class="app-header__titles">
        <h1>旅游攻略管理平台</h1>
        <span>Travel Guide Console · 三维地图底座</span>
      </div>
    </div>

    <nav class="app-header__nav">
      <button
        v-for="item in NAV"
        :key="item.key"
        type="button"
        class="app-header__nav-item"
        :class="{ 'is-active': item.enabled && ui.activeView === item.key, 'is-disabled': !item.enabled }"
        :disabled="!item.enabled"
        @click="go(item)"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="app-header__right">
      <button
        type="button"
        class="app-header__export"
        :disabled="!guideStore.guide || guideStore.exporting"
        :title="
          guideStore.guide
            ? '把当前攻略导出为可下载的 HTML（含住宿 / 起点两张路线图）'
            : '先打开一份攻略再导出'
        "
        @click="guideStore.exportGuideHtml()"
      >
        {{ guideStore.exporting ? '导出中…' : '导出攻略' }}
      </button>
      <span class="app-header__divider" />
      <span class="status-dot" :class="tokenClass" />
      <span class="app-header__status">天地图 {{ tokenText }}</span>
      <span class="app-header__divider" />
      <span class="app-header__user">管理员</span>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  gap: 28px;
  flex: 0 0 var(--header-h);
  height: var(--header-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, #ffffff 0%, #f3f7fd 100%);
  box-shadow: 0 1px 3px rgba(23, 43, 77, 0.06);
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.app-header__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), #1a5fd0);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
}

.app-header__titles h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.app-header__titles span {
  display: block;
  color: var(--text-3);
  font-size: 11px;
  letter-spacing: 0.3px;
}

.app-header__nav {
  display: flex;
  gap: 4px;
}

.app-header__nav-item {
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.app-header__nav-item:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.app-header__nav-item.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.app-header__nav-item.is-disabled {
  color: var(--text-3);
  cursor: not-allowed;
  opacity: 0.6;
}

.app-header__nav-item.is-disabled:hover {
  color: var(--text-3);
  background: none;
}

.app-header__right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  color: var(--text-2);
  font-size: 12px;
}

.app-header__divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-strong);
}

.app-header__export {
  padding: 5px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.app-header__export:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.app-header__export:disabled {
  background: none;
  color: var(--text-3);
  cursor: not-allowed;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.status-dot.is-ok {
  background: var(--success);
  box-shadow: 0 0 5px rgba(18, 160, 107, 0.55);
}

.status-dot.is-error {
  background: var(--danger);
  box-shadow: 0 0 5px rgba(224, 74, 74, 0.55);
}

.status-dot.is-pending {
  background: var(--warn);
}
</style>
