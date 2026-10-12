<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  deleteGuide,
  getGuide,
  listGuides,
  setGuideArchived,
  type GuideSummary,
} from '@/api/guide'
import { useGuideStore } from '@/stores/guide'
import { useUiStore } from '@/stores/ui'

const guideStore = useGuideStore()
const ui = useUiStore()

const guides = ref<GuideSummary[]>([])
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const includeArchived = ref(false)
const busyId = ref<string | null>(null)

/** 待确认的危险操作 */
const pending = ref<{ action: 'archive' | 'restore' | 'delete'; guide: GuideSummary } | null>(null)

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return guides.value
  return guides.value.filter((item) =>
    [item.title, item.region ?? '', item.summary ?? ''].some((field) =>
      field.toLowerCase().includes(text),
    ),
  )
})

const statusText: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    guides.value = await listGuides({ includeArchived: includeArchived.value })
  } catch (caught) {
    error.value = (caught as Error).message
  } finally {
    loading.value = false
  }
}

watch(includeArchived, load)
watch(
  () => ui.libraryVersion,
  () => void load(),
)

onMounted(load)

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** 打开：先立刻切到地图工作台，再拉取渲染（避免等路线规划完才跳转） */
async function open(item: GuideSummary): Promise<void> {
  busyId.value = item.id
  error.value = ''
  // 先跳转到 Cesium 地图工作台，载入过程与路线规划在后台继续
  ui.setView('map')
  try {
    await guideStore.loadGuide(item.id)
  } catch (caught) {
    // 载入失败则退回资源库，并把错误显示出来
    error.value = (caught as Error).message
    ui.setView('library')
  } finally {
    busyId.value = null
  }
}

/** 编辑：拉取完整攻略后打开编辑器 */
async function edit(item: GuideSummary): Promise<void> {
  busyId.value = item.id
  error.value = ''
  try {
    const full = await getGuide(item.id)
    ui.openEditor(full)
  } catch (caught) {
    error.value = (caught as Error).message
  } finally {
    busyId.value = null
  }
}

function ask(action: 'archive' | 'restore' | 'delete', guide: GuideSummary): void {
  pending.value = { action, guide }
}

async function confirmPending(): Promise<void> {
  const task = pending.value
  if (!task) return
  pending.value = null
  busyId.value = task.guide.id
  error.value = ''
  try {
    if (task.action === 'delete') {
      await deleteGuide(task.guide.id)
      if (guideStore.guide?.id === task.guide.id) guideStore.setGuide(null)
    } else {
      await setGuideArchived(task.guide.id, task.action === 'archive')
    }
    await load()
  } catch (caught) {
    error.value = (caught as Error).message
  } finally {
    busyId.value = null
  }
}

const confirmTitle = computed(() => {
  if (!pending.value) return ''
  return pending.value.action === 'delete'
    ? '删除攻略'
    : pending.value.action === 'archive'
      ? '归档攻略'
      : '恢复攻略'
})

const confirmBody = computed(() => {
  if (!pending.value) return ''
  const title = pending.value.guide.title
  if (pending.value.action === 'delete') {
    return `「${title}」将被永久删除：数据库中该攻略及其分日、节点、路线记录会同步清除，且无法恢复。确定删除？`
  }
  if (pending.value.action === 'archive') {
    return `「${title}」将归档（软删除），列表默认不再显示，但数据保留、可随时恢复。`
  }
  return `「${title}」将恢复为正常状态，重新出现在默认列表中。`
})
</script>

<template>
  <section class="lib">
    <header class="lib__head">
      <div class="lib__title-block">
        <h2 class="lib__title">攻略库</h2>
        <span class="lib__subtitle">浏览、编辑与管理历史攻略</span>
      </div>

      <div class="lib__toolbar">
        <input v-model="keyword" class="lib__search" type="search" placeholder="搜索标题 / 区域 / 摘要" />
        <label class="lib__check">
          <input v-model="includeArchived" type="checkbox" />
          含已归档
        </label>
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
        <button type="button" class="btn btn--primary" @click="ui.setView('map')">新建攻略</button>
      </div>
    </header>

    <p v-if="error" class="lib__error">{{ error }}</p>

    <div class="lib__body">
      <p v-if="loading" class="lib__state">加载中…</p>
      <p v-else-if="filtered.length === 0" class="lib__state">
        {{ keyword ? '没有匹配的攻略' : '还没有攻略，去地图工作台用一句话生成一份吧' }}
      </p>

      <ul v-else class="lib__list">
        <li
          v-for="item in filtered"
          :key="item.id"
          class="card"
          :class="{ 'is-archived': item.archived_at !== null }"
        >
          <div class="card__main">
            <div class="card__title-row">
              <span class="card__title">{{ item.title }}</span>
              <span v-if="item.region" class="card__chip">{{ item.region }}</span>
              <span class="card__chip card__chip--muted">
                {{ statusText[item.status] ?? item.status }}
              </span>
              <span v-if="item.archived_at" class="card__chip card__chip--warn">已归档</span>
            </div>
            <p class="card__summary">{{ item.summary || '（无摘要）' }}</p>
            <div class="card__meta">
              <span>{{ item.total_days }} 天</span>
              <span>{{ item.poi_count }} 节点</span>
              <span>创建于 {{ formatDate(item.created_at) }}</span>
            </div>
          </div>

          <div class="card__actions">
            <button type="button" class="btn" :disabled="busyId === item.id" @click="open(item)">
              打开
            </button>
            <button type="button" class="btn" :disabled="busyId === item.id" @click="edit(item)">
              编辑
            </button>
            <button
              v-if="item.archived_at"
              type="button"
              class="btn"
              :disabled="busyId === item.id"
              @click="ask('restore', item)"
            >
              恢复
            </button>
            <button
              v-else
              type="button"
              class="btn"
              :disabled="busyId === item.id"
              @click="ask('archive', item)"
            >
              归档
            </button>
            <button
              type="button"
              class="btn btn--danger"
              :disabled="busyId === item.id"
              title="永久删除该攻略，并同步清除数据库中的分日、节点与路线数据"
              @click="ask('delete', item)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- 确认弹窗 -->
    <div v-if="pending" class="confirm">
      <div class="confirm__box">
        <h3 class="confirm__title">{{ confirmTitle }}</h3>
        <p class="confirm__body">{{ confirmBody }}</p>
        <div class="confirm__actions">
          <button type="button" class="btn" @click="pending = null">取消</button>
          <button
            type="button"
            class="btn"
            :class="pending.action === 'delete' ? 'btn--danger' : 'btn--primary'"
            @click="confirmPending"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.lib {
  position: absolute;
  inset: 0;
  z-index: 11;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.lib__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.lib__title-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.lib__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.lib__subtitle {
  color: var(--text-3);
  font-size: 12px;
}

.lib__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.lib__search {
  width: 240px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-1);
  outline: none;
}

.lib__search:focus {
  border-color: var(--accent);
}

.lib__check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  font-size: 12px;
  user-select: none;
}

.lib__error {
  margin: 0;
  padding: 8px 22px;
  background: rgba(224, 74, 74, 0.08);
  color: var(--danger);
  font-size: 12px;
}

.lib__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 22px 28px;
}

.lib__state {
  margin: 60px 0 0;
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
}

.lib__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 1px 3px rgba(23, 43, 77, 0.05);
}

.card.is-archived {
  opacity: 0.72;
}

.card__main {
  flex: 1;
  min-width: 0;
}

.card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.card__title {
  color: var(--text-1);
  font-size: 14px;
  font-weight: 600;
}

.card__chip {
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}

.card__chip--muted {
  background: var(--chip-bg);
  color: var(--text-3);
}

.card__chip--warn {
  background: rgba(217, 134, 0, 0.14);
  color: var(--warn);
}

.card__summary {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card__meta {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  color: var(--text-3);
  font-size: 11px;
}

.card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 260px;
}

.btn--danger {
  border-color: var(--danger);
  color: var(--danger);
}

.btn--danger:hover {
  border-color: var(--danger);
  background: rgba(224, 74, 74, 0.08);
}

/* 确认弹窗 */
.confirm {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 26, 46, 0.35);
}

.confirm__box {
  width: 400px;
  max-width: calc(100% - 32px);
  padding: 18px 20px;
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: var(--panel-shadow);
}

.confirm__title {
  margin: 0 0 8px;
  font-size: 14px;
}

.confirm__body {
  margin: 0 0 18px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.7;
}

.confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
