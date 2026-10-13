<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useGuideStore } from '@/stores/guide'

const store = useGuideStore()

/**
 * 本轮的耗时计时统一由 store 维护（生成 / 改稿 / 提问 / 路线规划 / 重排共用一份），
 * 推理模型动辄要跑一两分钟，不给个计时用户只能干猜「是不是卡了」。
 */
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

/** 生成前的澄清问答：触发提问时的原始想法 + 用户逐题的答案 */
const clarifyPrompt = ref('')
/** 逐题的自由输入（多选题里就是「自己补的点」） */
const answers = ref<string[]>([])
/** 逐题勾选的选项：单选题最多一个，多选题可勾多个 */
const picks = ref<string[][]>([])

const busy = computed(() => store.busy)
const canRevise = computed(() => !!store.guide)
const guideTitle = computed(() => store.guide?.title ?? '')

/** 是否正在展示「AI 反问」面板 */
const asking = computed(() => mode.value === 'create' && store.clarifyQuestions.length > 0)

// 打开或切换攻略时，默认切到「修改当前攻略」
watch(
  () => store.guide?.id,
  (id) => {
    mode.value = id ? 'revise' : 'create'
  },
  { immediate: true },
)

// 新一批问题到达时重置答案与勾选（都与问题一一对应）
watch(
  () => store.clarifyQuestions,
  (questions) => {
    answers.value = questions.map(() => '')
    picks.value = questions.map(() => [])
  },
)

const placeholder = computed(() => {
  if (store.clarifying) return '正在整理要向你确认的信息…'
  if (store.generating) {
    return mode.value === 'revise' ? '正在改稿，请稍候…' : '正在生成攻略，请稍候…'
  }
  if (asking.value) return '先回答上面的问题，或点「跳过，直接生成」'
  if (mode.value === 'revise') {
    return '例如：把第 3 天下午改成稻城亚丁，并把行程压缩成 5 天'
  }
  return '例如：帮我做一份川西大环线 6 天自驾攻略'
})

const logTitle = computed(() => {
  if (store.clarifying) return '提问过程'
  return mode.value === 'revise' ? '改稿过程' : '生成过程'
})

/** 横条主按钮文案 */
const buttonText = computed(() => {
  if (asking.value) return '待确认'
  if (mode.value === 'revise' && canRevise.value) return '提交改稿'
  return '生成攻略'
})

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
  if (next === 'revise') cancelAsk()
}

async function submit(): Promise<void> {
  const prompt = input.value.trim()
  if (!prompt || busy.value || asking.value) return
  input.value = ''
  open.value = true

  if (mode.value === 'revise' && store.guide) {
    await store.revise(prompt)
    return
  }

  // 新建攻略：先让 AI 把影响行程走向的信息问清楚，再动手排
  clarifyPrompt.value = prompt
  const questions = await store.clarify(prompt)
  // 提问失败不该把用户堵死，直接按原想法生成
  if (!questions && store.error) {
    store.clearClarify()
    await store.generate(prompt)
  }
}

/**
 * 某一题的答案：多选题把勾中的选项与自由输入拼成一句，单选题就是输入框里的内容。
 * 多选题没勾任何选项时退化成自由输入，不会凭空塞内容进去。
 */
function answerOf(index: number): string {
  const typed = (answers.value[index] ?? '').trim()
  if (!store.clarifyQuestions[index]?.multiple) return typed
  const picked = picks.value[index] ?? []
  return [...picked, typed].filter(Boolean).join('、')
}

/** 清空全部作答（提交 / 跳过 / 收起时都清一次） */
function resetAnswers(): void {
  answers.value = []
  picks.value = []
}

/** 把「原始想法 + 用户在问答里确认的答案」合并成最终 prompt */
function buildPrompt(): string {
  const lines = store.clarifyQuestions
    .map((item, index) => {
      const answer = answerOf(index)
      return answer ? `${index + 1}. ${item.question} ${answer}` : ''
    })
    .filter(Boolean)

  if (lines.length === 0) return clarifyPrompt.value
  return `${clarifyPrompt.value}\n\n【已确认的补充信息】\n${lines.join('\n')}`
}

/** 答完问题，正式开始生成 */
async function startGenerate(): Promise<void> {
  if (busy.value) return
  const prompt = buildPrompt()
  store.clearClarify()
  resetAnswers()
  await store.generate(prompt)
}

/** 一个问题都不答，直接按原始想法生成 */
async function skipClarify(): Promise<void> {
  if (busy.value) return
  const prompt = clarifyPrompt.value
  store.clearClarify()
  resetAnswers()
  await store.generate(prompt)
}

/** 收起问答面板，并把原始想法放回输入框方便重新编辑 */
function cancelAsk(): void {
  if (store.clarifyQuestions.length === 0) return
  const original = clarifyPrompt.value
  store.clearClarify()
  resetAnswers()
  if (original) input.value = original
}

/** 单选题直接把选项填进输入框；多选题点一下勾上，再点一下取消 */
function pickAnswer(index: number, option: string): void {
  const question = store.clarifyQuestions[index]
  if (!question) return
  if (!question.multiple) {
    answers.value[index] = option
    return
  }
  const picked = picks.value[index]
  if (!picked) return
  const at = picked.indexOf(option)
  if (at >= 0) picked.splice(at, 1)
  else picked.push(option)
}

/** 选项是否处于选中态 */
function isPicked(index: number, option: string): boolean {
  const question = store.clarifyQuestions[index]
  if (!question) return false
  if (!question.multiple) return answers.value[index] === option
  return (picks.value[index] ?? []).includes(option)
}

function onInputKeydown(event: KeyboardEvent): void {
  // 输入框是多行的：单独 Enter 直接换行（方便写分点的需求），
  // Ctrl / ⌘ + Enter 才发送
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void submit()
  }
}

/**
 * 只有「新增了一行日志」才滚到底。
 *
 * 别把 reasoning.length 也算进来：下面这行 scrollTop 赋值会**强制同步布局**，
 * 而推理增量一次生成有几万字符，等于让浏览器每秒做几十上百次布局
 * —— 界面就是这么被拖死的。思考文本本来就被限制在固定高度的小框里，
 * 它的内容变化不影响面板本身的高度。
 */
watch(
  () => store.logs.length,
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

    <!-- 进度：百分比只有真正在落点生成时才有意义，耗时则在整轮任务（含路线规划）里一直显示 -->
    <div v-if="store.busy" class="ai__status">
      <span class="ai__status-text">{{ store.stage }}</span>
      <span class="ai__status-pct">
        <template v-if="store.generating">{{ progressPercent }}% · </template>{{ store.elapsedSec }}s
      </span>
    </div>
    <div v-if="store.generating" class="ai__progress">
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

    <!-- 生成前的澄清问答：AI 先问清楚，用户答完再排行程 -->
    <div v-if="asking" class="ai__ask">
      <div class="ai__ask-head">
        <span>开始排行程前，先确认几件事</span>
        <button type="button" class="ai__link" @click="cancelAsk">收起</button>
      </div>

      <div class="ai__ask-body">
        <div v-for="(item, index) in store.clarifyQuestions" :key="index" class="ask">
          <p class="ask__q">
            {{ index + 1 }}. {{ item.question }}
            <span v-if="item.multiple" class="ask__tag">可多选</span>
          </p>
          <div v-if="item.options.length > 0" class="ask__opts">
            <button
              v-for="option in item.options"
              :key="option"
              type="button"
              class="ask__opt"
              :class="{ 'is-picked': isPicked(index, option) }"
              @click="pickAnswer(index, option)"
            >
              {{ option }}
            </button>
          </div>
          <input
            v-model="answers[index]"
            class="ask__input"
            type="text"
            :placeholder="item.multiple ? '也可以自己补想去的点，多个用顿号隔开…' : '也可以自己填…'"
          />
        </div>
      </div>

      <div class="ai__ask-foot">
        <button type="button" class="ai__btn ai__btn--ghost" :disabled="busy" @click="skipClarify">
          跳过，直接生成
        </button>
        <button type="button" class="ai__btn" :disabled="busy" @click="startGenerate">
          开始生成攻略
        </button>
      </div>
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

      <textarea
        v-model="input"
        class="ai__input"
        rows="2"
        :disabled="busy"
        :placeholder="placeholder"
        title="Enter 换行，Ctrl + Enter 发送"
        @keydown="onInputKeydown"
      ></textarea>

      <button
        v-if="store.generating || store.clarifying"
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
        :disabled="!input.trim() || busy || asking"
        @click="submit"
      >
        {{ buttonText }}
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
  white-space: nowrap;
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
  /* 表头不换行：宽度不够时压缩右侧的「当前：xx」，按钮文字始终单行 */
  flex-wrap: nowrap;
}

.ai__seg {
  flex: 0 0 auto;
  display: inline-flex;
  padding: 2px;
  border-radius: 6px;
  background: rgba(23, 43, 77, 0.06);
  white-space: nowrap;
}

.ai__seg-btn {
  flex: 0 0 auto;
  padding: 3px 10px;
  border-radius: 5px;
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
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
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 生成前的澄清问答 ---------- */
.ai__ask {
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: rgba(47, 125, 250, 0.04);
}

.ai__ask-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

.ai__ask-body {
  max-height: 260px;
  padding: 10px 12px;
  overflow-y: auto;
}

.ask + .ask {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.ask__q {
  margin: 0 0 6px;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.5;
}

/* 「可多选」标记：跟着题干走，别让用户以为点了就换掉上一个 */
.ask__tag {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  line-height: 16px;
}

.ask__opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.ask__opt {
  padding: 3px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-panel);
  color: var(--text-2);
  font-size: 11px;
  line-height: 17px;
  transition: all 0.15s;
}

.ask__opt:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.ask__opt.is-picked {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.ask__input {
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-1);
  outline: none;
  font-size: 12px;
}

.ask__input:focus {
  border-color: var(--accent);
}

.ask__input::placeholder {
  color: var(--text-3);
}

.ai__ask-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
}

/* ---------- 横条 ---------- */
.ai__bar {
  display: flex;
  /* 输入框是多行的、还能手动拉高，所以按钮贴底对齐，横条高度随输入框走 */
  align-items: flex-end;
  gap: 8px;
  min-height: 50px;
  padding: 8px 10px 8px 6px;
}

.ai__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-bottom: 4px;
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
  margin-bottom: 8px;
  color: var(--accent);
  font-size: 14px;
}

/*
 * 多行输入框：默认两行高，右下角可以拖着改高度，Enter 直接换行。
 * 注意过渡只作用于边框与底色 —— 如果写成 transition: all，
 * 手动拖拽改变高度时会被过渡拖住，手感很黏。
 */
.ai__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 36px;
  /* 再高就超出面板了，到这个高度后改为内部滚动 */
  max-height: 200px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(23, 43, 77, 0.05);
  color: var(--text-1);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
  outline: none;
  transition:
    border-color 0.15s,
    background 0.15s;
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
  resize: none;
}

/* 右下角的拖拽手柄给个更明显的样式，提示「这里可以拉高」 */
.ai__input::-webkit-resizer {
  border-bottom-right-radius: 6px;
  background: linear-gradient(
    135deg,
    transparent 0 58%,
    var(--text-3) 58% 66%,
    transparent 66% 76%,
    var(--text-3) 76% 84%,
    transparent 84%
  );
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
