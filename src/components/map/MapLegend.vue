<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue'
import { dayColor } from '@/config/guide'
import { iconUri, type LegendEntry } from '@/config/mapIcons'
import { useGuideStore } from '@/stores/guide'

/**
 * 右上角地图图例。
 *
 * 条目与地图渲染共用 `@/config/mapIcons` 里的同一份分类定义，
 * 点击某一行即切换该类型（景点 / 住宿 / 起点 / 导航路线…）的显隐。
 */
const store = useGuideStore()

/** 面板是否收起（只留标题栏） */
const collapsed = ref(false)

const hiddenCount = computed(() => store.legendEntries.filter((entry) => entry.hidden).length)

/** 有数据、但天被时间轴隐藏掉的类型数（数量为 0 且不是图例关掉的） */
const dayHiddenCount = computed(
  () => store.legendEntries.filter((entry) => entry.count === 0 && !entry.hidden).length,
)

/**
 * 行程天数（按第几天排序）。
 * 配色与地图上的导航路线同源（dayColor），点击可切换该天显隐，与时间轴联动。
 */
const days = computed(() =>
  [...(store.guide?.days ?? [])].sort((a, b) => a.day_index - b.day_index),
)

function isDayHidden(dayIndex: number): boolean {
  return store.hiddenDays.includes(dayIndex)
}

/** 点位图标：与地图上同源，保证图例和实景一致 */
function pointIcon(entry: LegendEntry): string {
  return entry.item.shape === 'point' ? iconUri(entry.item.key, entry.item.color) : ''
}

/** 线型样本：跨天转移用虚线；导航路线用线上的一串「›››」箭头，顺带说明前进方向 */
function lineStyle(entry: LegendEntry): CSSProperties {
  if (entry.item.shape !== 'line') return {}
  const { color, dash } = entry.item
  if (dash) {
    return { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }
  }
  // 与地图上的观感一致：实线上每隔一段一个指向行进方向的箭头
  const chevron =
    `<svg xmlns='http://www.w3.org/2000/svg' width='10' height='8'>` +
    `<path d='M1 1 L5 4 L1 7' fill='none' stroke='${color}' stroke-width='2' ` +
    `stroke-linecap='round' stroke-linejoin='round'/></svg>`
  return {
    width: '18px',
    height: '8px',
    background: `url("data:image/svg+xml,${encodeURIComponent(chevron)}") repeat-x left center`,
    backgroundSize: '10px 8px',
  }
}
</script>

<template>
  <aside v-if="store.legendEntries.length > 0" class="legend">
    <header class="legend__head">
      <span class="legend__title">图例</span>
      <button
        type="button"
        class="legend__link"
        :title="store.allCategoriesHidden ? '显示全部类型' : '隐藏全部类型'"
        @click="store.toggleAllCategories()"
      >
        {{ store.allCategoriesHidden ? '全部显示' : '全部隐藏' }}
      </button>
      <button
        type="button"
        class="legend__link legend__caret"
        :title="collapsed ? '展开图例' : '收起图例'"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? '▸' : '▾' }}
      </button>
    </header>

    <div v-if="!collapsed && days.length > 0" class="legend__days">
      <div class="legend__days-title">天数配色</div>
      <div class="legend__days-grid">
        <button
          v-for="day in days"
          :key="day.id"
          type="button"
          class="legend__day"
          :class="{ 'is-off': isDayHidden(day.day_index) }"
          :aria-pressed="!isDayHidden(day.day_index)"
          :title="`${isDayHidden(day.day_index) ? '显示' : '隐藏'}第 ${day.day_index} 天`"
          @click="store.toggleDay(day.day_index)"
        >
          <i :style="{ background: dayColor(day.day_index) }" />
          <span>D{{ day.day_index }}</span>
        </button>
      </div>
    </div>

    <ul v-if="!collapsed" class="legend__list">
      <li v-for="entry in store.legendEntries" :key="entry.item.key">
        <button
          type="button"
          class="legend__row"
          :class="{ 'is-off': entry.hidden }"
          :aria-pressed="!entry.hidden"
          :title="`${entry.hidden ? '显示' : '隐藏'}「${entry.item.label}」`"
          @click="store.toggleCategory(entry.item.key)"
        >
          <span class="legend__swatch">
            <img v-if="entry.item.shape === 'point'" :src="pointIcon(entry)" alt="" />
            <span v-else class="legend__line" :style="lineStyle(entry)" />
          </span>
          <span class="legend__label">{{ entry.item.label }}</span>
          <span class="legend__count">{{ entry.count }}</span>
        </button>
      </li>
    </ul>

    <p v-if="!collapsed && (hiddenCount > 0 || dayHiddenCount > 0)" class="legend__foot">
      <span v-if="dayHiddenCount > 0">天优先：{{ dayHiddenCount }} 类已被时间轴隐藏</span>
      <span v-if="hiddenCount > 0">已按类型隐藏 {{ hiddenCount }} 类，点击行恢复</span>
    </p>
  </aside>
</template>

<style scoped>
.legend {
  width: 158px;
  max-height: calc(100% - 28px);
  /* 外层容器为了让地图可点设了 pointer-events: none，这里自己声明回来，
     不依赖父组件的后代选择器，保证面板任何情况下都可交互 */
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--panel-bg);
  backdrop-filter: blur(8px);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.legend__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.legend__title {
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
}

.legend__link {
  color: var(--text-3);
  font-size: 11px;
}

.legend__link:hover {
  color: var(--accent);
}

.legend__caret {
  margin-left: auto;
  font-size: 10px;
}

.legend__days {
  flex: 0 0 auto;
  padding: 7px 10px 8px;
  border-bottom: 1px solid var(--border);
}

.legend__days-title {
  margin-bottom: 5px;
  color: var(--text-3);
  font-size: 11px;
}

.legend__days-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}

.legend__day {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text-1);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.15s;
}

.legend__day:hover {
  background: var(--bg-hover);
}

.legend__day i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.legend__day.is-off {
  opacity: 0.4;
  text-decoration: line-through;
}

.legend__list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 4px 0 6px;
  overflow-y: auto;
  list-style: none;
}

.legend__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 10px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.legend__row:hover {
  background: var(--bg-hover);
}

.legend__row.is-off {
  opacity: 0.4;
}

.legend__swatch {
  flex: 0 0 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
}

.legend__swatch img {
  width: 20px;
  height: 20px;
}

.legend__line {
  width: 18px;
  height: 3px;
  border-radius: 2px;
}

.legend__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-1);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend__row.is-off .legend__label {
  color: var(--text-3);
  text-decoration: line-through;
}

.legend__count {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.legend__foot {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.5;
}

.legend__foot span {
  display: block;
}
</style>
