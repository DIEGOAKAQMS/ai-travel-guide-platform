<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { fetchPoiPhotos } from '@/api/guide'
import { KIND_COLOR, KIND_ICON, KIND_TEXT, STATUS_TEXT, dayColor } from '@/config/guide'
import { useGuideStore } from '@/stores/guide'
import { useUiStore } from '@/stores/ui'
import type { PoiPhoto } from '@/types/guide'

/**
 * 地图点位便签（弹窗）。
 *
 * 定位由 CesiumViewer 每帧把经纬度投影成屏幕坐标后传进来（x / y，单位 px）。
 *
 * 内容分工：时间轴负责「什么时候到、玩多久、路上多少公里、玩法 / 避坑 / 建议」，
 * 便签负责「这地方到底怎么样」—— 实景图 + 详细介绍 + 看点 + 最佳时段 + 位置，
 * 刻意不复述时间轴上的内容。
 */
const props = defineProps<{
  x: number
  y: number
  /** 弹窗相对标记的方位：上方不够空间时自动放到下方 */
  placement: 'top' | 'bottom'
}>()

/** 把真实高度报给父组件，让它按剩余空间决定放上方还是下方（图片加载后高度会变） */
const emit = defineEmits<{ resize: [height: number] }>()

const store = useGuideStore()
const ui = useUiStore()

const cardRef = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null

watch(cardRef, (el) => {
  observer?.disconnect()
  observer = null
  if (!el) return
  observer = new ResizeObserver(() => emit('resize', el.offsetHeight))
  observer.observe(el)
  emit('resize', el.offsetHeight)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

/** 当前弹窗对应的节点与所属天 */
const target = computed(() => {
  const id = ui.poiPopupId
  const guide = store.guide
  if (!id || !guide) return null
  for (const day of guide.days) {
    const poi = day.pois.find((item) => item.id === id)
    if (poi) return { poi, day }
  }
  return null
})

const poi = computed(() => target.value?.poi ?? null)
const day = computed(() => target.value?.day ?? null)

/** 落点异常提示（skipped / ok / manual 不提示） */
const problem = computed(() => {
  const item = poi.value
  if (!item) return ''
  if (item.geocode_status === 'ok' || item.geocode_status === 'manual') return ''
  if (item.geocode_status === 'skipped') return ''
  return STATUS_TEXT[item.geocode_status]
})

// ---------------------------------------------------------------- 实景图

/**
 * 图片缓存：同一张便签反复打开不再来回请求。
 * 攻略落点时已把高德 POI 的图存进库；老攻略没图，首次打开时按需补一次。
 */
const photoCache = new Map<string, PoiPhoto[]>()
const photoRequested = new Set<string>()

const photos = ref<PoiPhoto[]>([])
const broken = ref<string[]>([])
const index = ref(0)
const loadingPhotos = ref(false)

/** 过滤掉加载失败的图 */
const usable = computed(() => photos.value.filter((item) => !broken.value.includes(item.url)))
const hero = computed(() => usable.value[index.value] ?? null)

watch(
  () => poi.value?.id,
  async (id) => {
    index.value = 0
    broken.value = []
    photos.value = []
    if (!id) return

    const inline = poi.value?.photos ?? []
    if (inline.length > 0) {
      photos.value = inline
      return
    }

    const cached = photoCache.get(id)
    if (cached) {
      photos.value = cached
      return
    }
    if (photoRequested.has(id)) return
    photoRequested.add(id)

    loadingPhotos.value = true
    try {
      const result = await fetchPoiPhotos(id)
      photoCache.set(id, result.photos)
      photos.value = result.photos
    } catch {
      photoCache.set(id, [])
    } finally {
      loadingPhotos.value = false
    }
  },
  { immediate: true },
)

/** 某张图 404 / 防盗链失败 → 换下一张，别让便签开着天窗 */
function onImageError(url: string): void {
  if (!broken.value.includes(url)) broken.value.push(url)
  if (index.value >= usable.value.length) index.value = 0
}

function step(delta: number): void {
  const total = usable.value.length
  if (total < 2) return
  index.value = (index.value + delta + total) % total
}

// ---------------------------------------------------------------- 样式

const accent = computed(() => (day.value ? dayColor(day.value.day_index) : '#2f7dfa'))
const kindColor = computed(() => (poi.value ? KIND_COLOR[poi.value.kind] : '#2f7dfa'))

const style = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
  transform:
    props.placement === 'top'
      ? 'translate(-50%, calc(-100% - 74px))'
      : 'translate(-50%, 28px)',
}))
</script>

<template>
  <div v-if="poi && day" ref="cardRef" class="pop" :style="style" @click.stop>
    <!-- 头图：有实景图就用实景图，没有就用当天配色的渐变底 -->
    <div class="pop__hero" :class="{ 'is-loading': loadingPhotos && !hero }">
      <img
        v-if="hero"
        class="pop__hero-img"
        :src="hero.url"
        :alt="hero.title || poi.name"
        loading="lazy"
        @error="onImageError(hero.url)"
      />
      <span v-else class="pop__hero-fallback" :style="{ '--accent': accent }" />

      <div class="pop__scrim" />

      <div class="pop__hero-top">
        <span class="pop__chip" :style="{ background: accent }">D{{ day.day_index }}</span>
        <span class="pop__chip pop__chip--kind" :style="{ borderColor: kindColor, color: kindColor }">
          {{ KIND_ICON[poi.kind] }} {{ KIND_TEXT[poi.kind] }}
        </span>
        <button type="button" class="pop__close" title="关闭" @click="ui.closePoiPopup()">×</button>
      </div>

      <div class="pop__hero-bottom">
        <p class="pop__title">{{ poi.name }}</p>
        <p v-if="poi.address" class="pop__addr" :title="poi.address">{{ poi.address }}</p>
      </div>

      <template v-if="usable.length > 1">
        <button type="button" class="pop__nav pop__nav--prev" title="上一张" @click="step(-1)">
          ‹
        </button>
        <button type="button" class="pop__nav pop__nav--next" title="下一张" @click="step(1)">
          ›
        </button>
        <span class="pop__count">{{ index + 1 }} / {{ usable.length }}</span>
      </template>
    </div>

    <div class="pop__body">
      <div v-if="poi.highlights.length > 0 || poi.best_time" class="pop__chips">
        <span
          v-for="item in poi.highlights"
          :key="item"
          class="pop__tag"
          :style="{ background: `${kindColor}1f`, color: kindColor }"
        >
          {{ item }}
        </span>
        <span v-if="poi.best_time" class="pop__tag pop__tag--time">🕑 {{ poi.best_time }}</span>
      </div>

      <p v-if="poi.detail" class="pop__detail">{{ poi.detail }}</p>

      <div v-if="usable.length > 1" class="pop__thumbs">
        <button
          v-for="(item, i) in usable"
          :key="item.url"
          type="button"
          class="pop__thumb"
          :class="{ 'is-active': i === index }"
          :title="item.title || ''"
          @click="index = i"
        >
          <img :src="item.url" :alt="item.title || poi.name" loading="lazy" @error="onImageError(item.url)" />
        </button>
      </div>

      <p v-if="problem" class="pop__warn"><b>定位</b>{{ problem }}</p>

      <p v-if="!poi.detail && poi.highlights.length === 0 && !loadingPhotos" class="pop__empty">
        这条攻略生成时还没带详情内容，改稿或重新生成后会补上实景图与看点。
      </p>
    </div>
  </div>
</template>

<style scoped>
.pop {
  position: absolute;
  z-index: 15;
  width: 340px;
  max-width: calc(100vw - 32px);
  max-height: min(68vh, 520px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--panel-bg);
  box-shadow: 0 12px 32px rgba(23, 43, 77, 0.22);
  backdrop-filter: blur(10px);
  overflow: hidden;
}

/* ---------------- 头图 ---------------- */

.pop__hero {
  position: relative;
  flex: 0 0 auto;
  height: 158px;
  overflow: hidden;
  background: var(--bg-panel-2);
}

.pop__hero-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pop__hero-fallback {
  position: absolute;
  inset: 0;
  display: block;
  background: linear-gradient(140deg, var(--accent) 0%, rgba(23, 43, 77, 0.85) 100%);
}

.pop__hero.is-loading .pop__hero-fallback {
  background: linear-gradient(140deg, var(--accent) 0%, rgba(23, 43, 77, 0.85) 100%);
  animation: pop-pulse 1.4s ease-in-out infinite;
}

@keyframes pop-pulse {
  0%,
  100% {
    opacity: 0.82;
  }
  50% {
    opacity: 0.55;
  }
}

.pop__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgba(9, 20, 38, 0.82) 0%,
    rgba(9, 20, 38, 0.28) 46%,
    rgba(9, 20, 38, 0.24) 100%
  );
}

.pop__hero-top {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.pop__chip {
  padding: 0 6px;
  border-radius: 4px;
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  letter-spacing: 0.2px;
}

.pop__chip--kind {
  border: 1px solid;
  background: rgba(255, 255, 255, 0.9);
  font-weight: 500;
}

.pop__close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(9, 20, 38, 0.42);
  color: #ffffff;
  font-size: 15px;
  line-height: 1;
  backdrop-filter: blur(2px);
}

.pop__close:hover {
  background: rgba(9, 20, 38, 0.66);
}

.pop__hero-bottom {
  position: absolute;
  left: 11px;
  right: 11px;
  bottom: 9px;
}

.pop__title {
  margin: 0;
  color: #ffffff;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop__addr {
  margin: 3px 0 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop__nav {
  position: absolute;
  top: 50%;
  width: 22px;
  height: 30px;
  margin-top: -15px;
  border-radius: 6px;
  background: rgba(9, 20, 38, 0.36);
  color: #ffffff;
  font-size: 17px;
  line-height: 1;
}

.pop__nav:hover {
  background: rgba(9, 20, 38, 0.6);
}

.pop__nav--prev {
  left: 6px;
}

.pop__nav--next {
  right: 6px;
}

.pop__count {
  position: absolute;
  right: 9px;
  bottom: 9px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(9, 20, 38, 0.42);
  color: rgba(255, 255, 255, 0.9);
  font-size: 10px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 正文 ---------------- */

.pop__body {
  flex: 1 1 auto;
  padding: 10px 12px 12px;
  overflow-y: auto;
}

.pop__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 9px;
}

.pop__tag {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
}

.pop__tag--time {
  background: rgba(47, 125, 250, 0.12);
  color: var(--accent);
}

.pop__detail {
  margin: 0 0 9px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.75;
  text-align: justify;
}

.pop__thumbs {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  overflow-x: auto;
}

.pop__thumb {
  flex: 0 0 auto;
  width: 52px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  opacity: 0.72;
}

.pop__thumb.is-active,
.pop__thumb:hover {
  border-color: var(--accent);
  opacity: 1;
}

.pop__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pop__warn {
  margin: 0 0 6px;
  color: var(--warn);
  font-size: 11px;
  line-height: 1.6;
}

.pop__warn b {
  margin-right: 5px;
  font-weight: 500;
}

.pop__empty {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.7;
}
</style>
