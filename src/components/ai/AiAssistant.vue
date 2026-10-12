<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useGuideStore } from '@/stores/guide'

const store = useGuideStore()

const TAG: Record<string, string> = {
  user: '需求',
  stage: '进度',
  ok: '完成',
  warn: '注意',
  error: '错误',
}

const input = ref('')
const open = ref(false)
const logBody = ref<HTMLDivElement | null>(null)

/** 新建攻略 / 修改当前攻略 */
const mode = ref<'create' | 'revise'>('create')

const busy = computed(() => store.generating || store.routing)
const canRevise = computed(() => !!store.guide)
const guideTitle = computed(() => store.guide?.title ?? '')

// 打开或切换攻略时，默认切到「修改当前攻略」
watch(
  () => store.guide?.id,
  (id) => {
    mode.value = id ? 'revise' : 'create'
  },
  { immediate: true },
)

const placeholder = computed(() => {
  if (store.generating) {
    return mode.value === 'revise' ? '正在改稿，请稍候…' : '正在生成攻略，请稍候…'
  }
  if (mode.value === 'revise') {
    return '例如：把第 3 天下午改成稻城亚丁，并把行程压缩成 5 天'
  }
  return '例如：帮我做一份川西大环线 6 天自驾攻略'
})

const logTitle = computed(() => (mode.value === 'revise' ? '改稿过程' : '生成过程'))

const progressPercent = computed(() => {
  const { done, total } = store.poiProgress
  if (!total) return 0
  return Math.round((done / total) * 100)
})

/** 只保留尾部思考文本，避免长文本拖慢渲染 */
const reasoningTail = computed(() => {
  const text = store.reasoning.trim()
  return text.length > 700 ? `…${text.slice(-700)}` : text
})

function switchMode(next: 'create' | 'revise'): void {
  if (next === 'revise' && !canRevise.value) return
  mode.value = next
}

async function submit(): Promise<void> {
  const prompt = input.value.trim()
  if (!prompt || busy.value) return
  input.value = ''
  open.value = true
  if (mode.value === 'revise' && store.guide) {
    await store.revise(prompt)
  } else {
    await store.generate(prompt)
  }
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}

watch(
  () => store.logs.length + store.reasoning.length,
  async () => {
    if (!open.value) return
    await nextTick()
    const el = logBody.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="ai">
    <!-- 生成过程 -->
    <div v-if="open" class="ai__log">
      <div class="ai__log-head">
        <span>{{ logTitle }}</span>
        <button type="button" class="ai__link" @click="open = false">收起</button>
      </div>

      <div ref="logBody" class="ai__log-body">
        <p
          v-for="(line, index) in store.logs"
          :key="index"
          class="ai__line"
          :class="`ai__line--${line.role}`"
        >
          <span class="ai__tag">{{ TAG[line.role] ?? '' }}</span>{{ line.text }}
        </p>

        <div v-if="store.generating && reasoningTail" class="ai__thinking">
          <div class="ai__thinking-head">模型思考中</div>
          <div class="ai__thinking-body">{{ reasoningTail }}</div>
        </div>
      </div>
    </div>

    <!-- 进度 -->
    <div v-if="busy" class="ai__status">
      <span class="ai__status-text">{{ store.stage }}</span>
      <span class="ai__status-pct">{{ progressPercent }}%</span>
    </div>
    <div v-if="busy" class="ai__progress">
      <div class="ai__progress-bar" :style="{ width: `${progressPercent}%` }" />
    </div>

    <!-- 模式：新建 / 修改当前攻略 -->
    <div class="ai__mode">
      <div class="ai__seg">
        <button
          type="button"
          class="ai__seg-btn"
          :class="{ 'is-active': mode === 'create' }"
          @click="switchMode('create')"
        >
          新建攻略
        </button>
        <button
          type="button"
          class="ai__seg-btn"
          :class="{ 'is-active': mode === 'revise' }"
          :disabled="!canRevise"
          :title="canRevise ? '按你的要求修改当前打开的攻略' : '先打开一份攻略再修改'"
          @click="switchMode('revise')"
        >
          修改当前
        </button>
      </div>
      <span v-if="mode === 'revise' && canRevise" class="ai__ctx" :title="guideTitle">
        当前：{{ guideTitle }}
      </span>
    </div>

    <!-- 横条 -->
    <div class="ai__bar">
      <button
        type="button"
        class="ai__toggle"
        :class="{ 'is-open': open }"
        :title="open ? '收起生成过程' : '展开生成过程'"
        @click="open = !open"
      >
        ▴
      </button>

      <span class="ai__spark">✦</span>

      <input
        v-model="input"
        class="ai__input"
        type="text"
        :disabled="busy"
        :placeholder="placeholder"
        @keydown="onInputKeydown"
      />

      <button
        v-if="store.generating"
        type="button"
        class="ai__btn ai__btn--ghost"
        @click="store.cancel()"
      >
        停止
      </button>
      <button
        v-else
        type="button"
        class="ai__btn"
        :disabled="!input.trim() || busy"
        @click="submit"
      >
        {{ mode === 'revise' && canRevise ? '提交改稿' : '生成攻略' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai {
  width: 460px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel-bg);
  backdrop-filter: blur(10px);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

/* ---------- 日志 ---------- */
.ai__log {
  border-bottom: 1px solid var(--border);
}

.ai__log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

.ai__link {
  color: var(--text-3);
  font-size: 12px;
}

.ai__link:hover {
  color: var(--accent);
}

.ai__log-body {
  max-height: 260px;
  padding: 8px 12px;
  overflow-y: auto;
}

.ai__line {
  display: flex;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.55;
  word-break: break-all;
}

.ai__tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--chip-bg);
  color: var(--text-3);
  font-size: 10px;
  line-height: 16px;
}

.ai__line--user {
  color: var(--text-1);
}
.ai__line--user .ai__tag {
  background: var(--accent-soft);
  color: var(--accent);
}
.ai__line--ok .ai__tag {
  background: rgba(18, 160, 107, 0.14);
  color: var(--success);
}
.ai__line--warn .ai__tag {
  background: rgba(217, 134, 0, 0.14);
  color: var(--warn);
}
.ai__line--error {
  color: var(--danger);
}
.ai__line--error .ai__tag {
  background: rgba(224, 74, 74, 0.14);
  color: var(--danger);
}

.ai__thinking {
  margin-top: 8px;
  border-left: 2px solid var(--border-strong);
  padding-left: 10px;
}

.ai__thinking-head {
  margin-bottom: 4px;
  color: var(--text-3);
  font-size: 11px;
}

.ai__thinking-body {
  max-height: 96px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
  white-space: pre-wrap;
}

/* ---------- 进度 ---------- */
.ai__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 12px 0;
  color: var(--text-2);
  font-size: 11px;
}

.ai__status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai__status-pct {
  flex: 0 0 auto;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.ai__progress {
  height: 2px;
  margin-top: 6px;
  background: #e3e9f3;
}

.ai__progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #22c3a6);
  transition: width 0.25s ease;
}

/* ---------- 模式切换 ---------- */
.ai__mode {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 0;
}

.ai__seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 6px;
  background: rgba(23, 43, 77, 0.06);
}

.ai__seg-btn {
  padding: 3px 10px;
  border-radius: 5px;
  color: var(--text-2);
  font-size: 11px;
  transition: all 0.15s;
}

.ai__seg-btn.is-active {
  background: var(--bg-panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(23, 43, 77, 0.12);
}

.ai__seg-btn:disabled {
  color: var(--text-3);
  cursor: not-allowed;
  opacity: 0.6;
}

.ai__ctx {
  min-width: 0;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 横条 ---------- */
.ai__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 50px;
  padding: 0 10px 0 6px;
}

.ai__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  color: var(--text-3);
  font-size: 11px;
  transition: all 0.15s;
}

.ai__toggle:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.ai__toggle.is-open {
  transform: rotate(180deg);
}

.ai__spark {
  color: var(--accent);
  font-size: 14px;
}

.ai__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(23, 43, 77, 0.05);
  color: var(--text-1);
  outline: none;
  transition: all 0.15s;
}

.ai__input::placeholder {
  color: var(--text-3);
}

.ai__input:focus {
  border-color: var(--accent);
  background: rgba(47, 125, 250, 0.07);
}

.ai__input:disabled {
  color: var(--text-3);
}

.ai__btn {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  transition: all 0.15s;
}

.ai__btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.ai__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ai__btn--ghost {
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
}

.ai__btn--ghost:hover {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
