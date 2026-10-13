<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { searchPlace, type PlaceCandidateDto } from '@/api/guide'
import { KIND_ICON } from '@/config/guide'
import type { NodeKind } from '@/types/guide'

const props = defineProps<{
  /** 这一站要加进哪一天（标题展示用，如「D3 · 巴朗山 → 四姑娘山镇」） */
  dayLabel: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (
    e: 'confirm',
    value: {
      name: string
      kind: NodeKind
      city: string | null
      address: string | null
      lng: number
      lat: number
    },
  ): void
}>()

interface KindOption {
  kind: NodeKind
  label: string
  hint: string
}

/**
 * 类型清单。
 *
 * 标签用业务口径（起点 / 景点 / 住宿…），值仍然是后端的 NodeKind，
 * 「出发 / 赶路」对应 drive、「住宿 / 城镇」对应 town。
 */
const KIND_OPTIONS: KindOption[] = [
  { kind: 'drive', label: '出发 / 赶路', hint: '当天起点，或路上的长距离移动' },
  { kind: 'spot', label: '景点', hint: '景区、寺庙、藏寨、湖泊' },
  { kind: 'view', label: '观景台', hint: '垭口、观景点、机位' },
  { kind: 'meal', label: '用餐', hint: '午餐、晚餐、补给' },
  { kind: 'town', label: '住宿 / 城镇', hint: '当晚的落脚点' },
  { kind: 'rest', label: '休整', hint: '休息、加油、服务区' },
]

const step = ref<'kind' | 'search'>('kind')
const pickedKind = ref<NodeKind | null>(null)
const keyword = ref('')
const searching = ref(false)
const error = ref('')
const candidates = ref<PlaceCandidateDto[]>([])
/** 是否已经搜过一轮（用于区分「还没搜」与「搜了但没结果」） */
const searched = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

const kindLabel = computed(
  () => KIND_OPTIONS.find((item) => item.kind === pickedKind.value)?.label ?? '',
)

watch(step, async (value) => {
  if (value !== 'search') return
  await nextTick()
  inputRef.value?.focus()
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function pickKind(kind: NodeKind): void {
  pickedKind.value = kind
  step.value = 'search'
}

function back(): void {
  if (step.value === 'search') {
    step.value = 'kind'
    pickedKind.value = null
    keyword.value = ''
    candidates.value = []
    searched.value = false
    error.value = ''
    return
  }
  emit('close')
}

async function runSearch(): Promise<void> {
  const text = keyword.value.trim()
  if (!text || searching.value) return

  searching.value = true
  error.value = ''
  candidates.value = []
  try {
    candidates.value = await searchPlace(text)
    searched.value = true
  } catch (caught) {
    error.value = (caught as Error).message
  } finally {
    searching.value = false
  }
}

function confirm(candidate: PlaceCandidateDto): void {
  if (!pickedKind.value) return
  emit('confirm', {
    name: candidate.name,
    kind: pickedKind.value,
    city: candidate.city || null,
    address: candidate.address || null,
    lng: candidate.lng,
    lat: candidate.lat,
  })
}
</script>

<template>
  <div class="dlg" @click.self="emit('close')">
    <div class="dlg__panel">
      <header class="dlg__head">
        <h3 class="dlg__title">{{ step === 'kind' ? '添加行程' : '选择具体地点' }}</h3>
        <span v-if="step === 'search'" class="dlg__chip">
          {{ KIND_ICON[pickedKind ?? 'spot'] }} {{ kindLabel }}
        </span>
        <span class="dlg__target" :title="props.dayLabel">{{ props.dayLabel }}</span>
        <button type="button" class="dlg__x" title="关闭" @click="emit('close')">✕</button>
      </header>

      <!-- 第一步：选类型 -->
      <div v-if="step === 'kind'" class="dlg__body">
        <p class="dlg__hint">先选这一站是什么类型，再到地图上找具体地点。</p>
        <div class="dlg__kinds">
          <button
            v-for="option in KIND_OPTIONS"
            :key="option.kind"
            type="button"
            class="kindcard"
            @click="pickKind(option.kind)"
          >
            <span class="kindcard__icon">{{ KIND_ICON[option.kind] }}</span>
            <span class="kindcard__text">
              <span class="kindcard__label">{{ option.label }}</span>
              <span class="kindcard__hint">{{ option.hint }}</span>
            </span>
          </button>
        </div>
      </div>

      <!-- 第二步：搜索 + 确认地址 -->
      <div v-else class="dlg__body">
        <form class="dlg__search" @submit.prevent="runSearch">
          <input
            ref="inputRef"
            v-model="keyword"
            class="dlg__input"
            type="text"
            placeholder="搜索地名，如：四姑娘山 双桥沟"
          />
          <button type="submit" class="btn btn--primary" :disabled="searching || !keyword.trim()">
            {{ searching ? '搜索中…' : '搜索' }}
          </button>
        </form>

        <p v-if="error" class="dlg__error">{{ error }}</p>

        <ul v-if="candidates.length > 0" class="dlg__list">
          <li v-for="(item, index) in candidates" :key="`${item.name}-${index}`" class="cand">
            <span class="cand__main">
              <span class="cand__name">{{ item.name }}</span>
              <span class="cand__addr">{{ item.address || item.city || '地址未知' }}</span>
            </span>
            <button type="button" class="btn btn--mini" @click="confirm(item)">添加</button>
          </li>
        </ul>

        <p v-else-if="searched && !searching" class="dlg__empty">
          没搜到结果，换个更具体的地名试试（如「丹巴 甲居藏寨」）。
        </p>
        <p v-else-if="!searched" class="dlg__hint">
          输入地名后回车搜索；点某条结果的「添加」即把它加入这一天的行程。
        </p>
      </div>

      <footer class="dlg__foot">
        <button type="button" class="btn" @click="back">
          {{ step === 'kind' ? '取消' : '上一步' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 26, 46, 0.35);
}

.dlg__panel {
  display: flex;
  flex-direction: column;
  width: 460px;
  max-width: 100%;
  max-height: 74vh;
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.dlg__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, #ffffff 0%, #f5f8fd 100%);
}

.dlg__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.dlg__chip {
  padding: 1px 8px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  line-height: 17px;
}

.dlg__target {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dlg__x {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 12px;
}

.dlg__x:hover {
  color: var(--accent);
}

.dlg__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

.dlg__hint,
.dlg__empty,
.dlg__error {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.7;
}

.dlg__error {
  margin-top: 8px;
  color: var(--danger);
}

.dlg__empty {
  padding: 12px 0;
}

/* ---------- 类型卡片 ---------- */
.dlg__kinds {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.kindcard {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--bg-panel-2);
  text-align: left;
  transition: all 0.15s;
}

.kindcard:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.kindcard__icon {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 13px;
  line-height: 18px;
}

.kindcard__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kindcard__label {
  color: var(--text-1);
  font-size: 12px;
  font-weight: 500;
}

.kindcard__hint {
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.5;
}

/* ---------- 搜索 ---------- */
.dlg__search {
  display: flex;
  gap: 8px;
}

.dlg__input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-1);
  outline: none;
  font-size: 12px;
}

.dlg__input:focus {
  border-color: var(--accent);
}

.dlg__list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel-2);
}

.cand:hover {
  border-color: var(--accent);
}

.cand__main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cand__name {
  overflow: hidden;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cand__addr {
  overflow: hidden;
  color: var(--text-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dlg__foot {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
}

.btn--mini {
  padding: 3px 9px;
  font-size: 11px;
}
</style>
