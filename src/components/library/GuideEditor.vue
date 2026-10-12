<script setup lang="ts">
import { computed, ref } from 'vue'
import { KIND_TEXT, PRIORITY_TEXT } from '@/config/guide'
import { saveGuide } from '@/api/guide'
import { useGuideStore } from '@/stores/guide'
import { useUiStore } from '@/stores/ui'
import type { NodeKind, NodePriority } from '@/types/guide'

const ui = useUiStore()
const guideStore = useGuideStore()

const saving = ref(false)
const error = ref('')

const KINDS = Object.keys(KIND_TEXT) as NodeKind[]
const PRIORITIES = Object.keys(PRIORITY_TEXT) as NodePriority[]

const draft = computed(() => ui.draft)

function isCollapsed(dayKey: string): boolean {
  return ui.editorCollapsed.includes(dayKey)
}

async function save(replan: boolean): Promise<void> {
  if (!ui.draft) return
  const payload = ui.toSavePayload()
  if (!payload) return

  saving.value = true
  error.value = ''
  try {
    const saved = await saveGuide(ui.draft.id, payload)
    // 回填当前打开的攻略并刷新攻略库列表
    guideStore.setGuide(saved)
    ui.bumpLibrary()
    ui.discardDraft()
    ui.closeEditor()
    if (replan) await guideStore.planRoutes()
  } catch (caught) {
    error.value = (caught as Error).message
  } finally {
    saving.value = false
  }
}

function close(): void {
  if (saving.value) return
  ui.discardDraft()
  ui.closeEditor()
}
</script>

<template>
  <div v-if="draft" class="ed">
    <div class="ed__panel">
      <header class="ed__head">
        <div class="ed__head-title">
          <h2 class="ed__title">编辑攻略</h2>
          <span class="ed__hint">改完后可选择是否重新规划驾车路线</span>
        </div>

        <div class="ed__head-actions">
          <span v-if="error" class="ed__error">{{ error }}</span>
          <button type="button" class="btn" :disabled="saving" @click="close">取消</button>
          <button type="button" class="btn" :disabled="saving" @click="save(false)">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button type="button" class="btn btn--primary" :disabled="saving" @click="save(true)">
            保存并重算路线
          </button>
        </div>
      </header>

      <div class="ed__body">
        <!-- 基础信息 -->
        <section class="ed__section">
          <h3 class="ed__section-title">基础信息</h3>
          <div class="ed__grid">
            <label class="field field--wide">
              <span class="field__label">标题</span>
              <input v-model="draft.title" class="field__input" type="text" />
            </label>
            <label class="field">
              <span class="field__label">区域</span>
              <input v-model="draft.region" class="field__input" type="text" placeholder="如 川西" />
            </label>
          </div>
          <label class="field field--block">
            <span class="field__label">摘要</span>
            <textarea v-model="draft.summary" class="field__input field__textarea" rows="2" />
          </label>
        </section>

        <!-- 每天 -->
        <section v-for="day in draft.days" :key="day.key" class="ed__day">
          <header class="ed__day-head" @click="ui.toggleEditorCollapsed(day.key)">
            <span class="ed__caret">{{ isCollapsed(day.key) ? '▸' : '▾' }}</span>
            <span class="ed__day-title">
              D{{ day.day_index }}<template v-if="day.title"> · {{ day.title }}</template>
            </span>
            <span class="ed__day-meta">{{ day.pois.length }} 节点</span>
            <div class="ed__day-actions" @click.stop>
              <button type="button" class="btn btn--mini" @click="ui.moveDay(day.key, -1)">上移</button>
              <button type="button" class="btn btn--mini" @click="ui.moveDay(day.key, 1)">下移</button>
              <button type="button" class="btn btn--mini btn--danger" @click="ui.removeDay(day.key)">
                删除天
              </button>
            </div>
          </header>

          <div v-show="!isCollapsed(day.key)" class="ed__day-body">
            <div class="ed__grid">
              <label class="field field--wide">
                <span class="field__label">当日主题</span>
                <input v-model="day.title" class="field__input" type="text" />
              </label>
              <label class="field field--wide">
                <span class="field__label">路线串联</span>
                <input v-model="day.route_text" class="field__input" type="text" placeholder="成都 → 都江堰 → 四姑娘山镇" />
              </label>
              <label class="field">
                <span class="field__label">住宿地</span>
                <input v-model="day.stay_text" class="field__input" type="text" />
              </label>
              <label class="field">
                <span class="field__label">车程（km）</span>
                <input v-model="day.drive_km" class="field__input" type="number" />
              </label>
              <label class="field">
                <span class="field__label">车程文案</span>
                <input v-model="day.drive_hours" class="field__input" type="text" placeholder="4–5 h" />
              </label>
              <label class="field">
                <span class="field__label">住宿海拔（m）</span>
                <input v-model="day.sleep_altitude_m" class="field__input" type="number" />
              </label>
              <label class="field">
                <span class="field__label">最高海拔（m）</span>
                <input v-model="day.max_altitude_m" class="field__input" type="number" />
              </label>
            </div>

            <label class="field field--block">
              <span class="field__label">当日概述</span>
              <textarea v-model="day.summary" class="field__input field__textarea" rows="2" />
            </label>
            <label class="field field--block">
              <span class="field__label">当日看点</span>
              <textarea v-model="day.highlights" class="field__input field__textarea" rows="2" />
            </label>
            <label class="field field--block">
              <span class="field__label">注意事项</span>
              <textarea v-model="day.cautions" class="field__input field__textarea" rows="2" />
            </label>
            <label class="field field--block">
              <span class="field__label">提示（每行一条）</span>
              <textarea v-model="day.notesText" class="field__input field__textarea" rows="2" />
            </label>

            <!-- 节点列表 -->
            <div class="ed__nodes">
              <div v-for="(poi, index) in day.pois" :key="poi.key" class="poi">
                <header class="poi__head">
                  <span class="poi__index">{{ index + 1 }}</span>
                  <input v-model="poi.name" class="field__input poi__name" type="text" placeholder="节点名称" />
                  <span class="poi__spacer" />
                  <button type="button" class="btn btn--mini" @click="ui.movePoi(day.key, poi.key, -1)">
                    上移
                  </button>
                  <button type="button" class="btn btn--mini" @click="ui.movePoi(day.key, poi.key, 1)">
                    下移
                  </button>
                  <button
                    type="button"
                    class="btn btn--mini btn--danger"
                    @click="ui.removePoi(day.key, poi.key)"
                  >
                    删除
                  </button>
                </header>

                <div class="ed__grid">
                  <label class="field">
                    <span class="field__label">类型</span>
                    <select v-model="poi.kind" class="field__input">
                      <option v-for="kind in KINDS" :key="kind" :value="kind">
                        {{ KIND_TEXT[kind] }}
                      </option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field__label">重要度</span>
                    <select v-model="poi.priority" class="field__input">
                      <option v-for="priority in PRIORITIES" :key="priority" :value="priority">
                        {{ PRIORITY_TEXT[priority] || '常规' }}
                      </option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field__label">到达时间</span>
                    <input v-model="poi.arrive_time" class="field__input" type="text" placeholder="09:00" />
                  </label>
                  <label class="field">
                    <span class="field__label">停留（分钟）</span>
                    <input v-model="poi.stay_minutes" class="field__input" type="number" />
                  </label>
                  <label class="field">
                    <span class="field__label">距上节点（km）</span>
                    <input v-model="poi.leg_km" class="field__input" type="number" />
                  </label>
                  <label class="field">
                    <span class="field__label">城市 / 行政区</span>
                    <input v-model="poi.city" class="field__input" type="text" placeholder="四川省甘孜州稻城县" />
                  </label>
                  <label class="field field--wide">
                    <span class="field__label">地址</span>
                    <input v-model="poi.address" class="field__input" type="text" />
                  </label>
                </div>

                <!-- 坐标 -->
                <div class="poi__coord">
                  <label class="field field--coord">
                    <span class="field__label">经度</span>
                    <input v-model="poi.lng" class="field__input" type="number" step="0.000001" />
                  </label>
                  <label class="field field--coord">
                    <span class="field__label">纬度</span>
                    <input v-model="poi.lat" class="field__input" type="number" step="0.000001" />
                  </label>
                  <button type="button" class="btn" @click="ui.startPicking(poi.key)">地图拾取</button>
                  <button type="button" class="btn" @click="ui.clearPoiCoord(poi.key)">清除坐标</button>
                  <span v-if="poi.manualCoord" class="poi__manual">人工指定</span>
                </div>

                <div class="ed__grid">
                  <label class="field field--wide">
                    <span class="field__label">玩法描述</span>
                    <textarea v-model="poi.notes" class="field__input field__textarea" rows="2" />
                  </label>
                  <label class="field field--wide">
                    <span class="field__label">避坑提醒</span>
                    <textarea v-model="poi.warnings" class="field__input field__textarea" rows="2" />
                  </label>
                  <label class="field field--wide">
                    <span class="field__label">实用建议</span>
                    <textarea v-model="poi.tips" class="field__input field__textarea" rows="2" />
                  </label>
                </div>
              </div>

              <button type="button" class="btn ed__add-poi" @click="ui.addPoi(day.key)">
                + 添加节点
              </button>
            </div>
          </div>
        </section>

        <button type="button" class="btn ed__add-day" @click="ui.addDay()">+ 添加一天</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ed {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 26, 46, 0.4);
}

.ed__panel {
  display: flex;
  flex-direction: column;
  width: 980px;
  max-width: 100%;
  max-height: 100%;
  border-radius: 12px;
  background: var(--bg-panel);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.ed__head {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, #ffffff 0%, #f5f8fd 100%);
}

.ed__head-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.ed__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.ed__hint {
  color: var(--text-3);
  font-size: 11px;
}

.ed__head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ed__error {
  max-width: 320px;
  color: var(--danger);
  font-size: 12px;
}

.ed__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 28px;
}

.ed__section {
  margin-bottom: 18px;
}

.ed__section-title {
  margin: 0 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

.ed__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field--wide {
  grid-column: span 4;
}

.field--block {
  margin-top: 10px;
}

.field--coord {
  width: 150px;
}

.field__label {
  color: var(--text-3);
  font-size: 11px;
}

.field__input {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-1);
  outline: none;
  font-size: 12px;
}

.field__input:focus {
  border-color: var(--accent);
}

.field__textarea {
  height: auto;
  padding: 6px 8px;
  line-height: 1.6;
  resize: vertical;
}

/* ---------- 天 ---------- */
.ed__day {
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.ed__day-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-panel-2);
  cursor: pointer;
  user-select: none;
}

.ed__caret {
  color: var(--text-3);
  font-size: 11px;
}

.ed__day-title {
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
}

.ed__day-meta {
  color: var(--text-3);
  font-size: 11px;
}

.ed__day-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.ed__day-body {
  padding: 12px;
}

/* ---------- 节点 ---------- */
.ed__nodes {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.poi {
  padding: 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: #fbfcfe;
}

.poi__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.poi__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}

.poi__name {
  width: 280px;
}

.poi__spacer {
  flex: 1;
}

.poi__coord {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin: 10px 0;
  flex-wrap: wrap;
}

.poi__manual {
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(18, 160, 107, 0.14);
  color: var(--success);
  font-size: 11px;
}

.ed__add-poi,
.ed__add-day {
  align-self: flex-start;
}

.ed__add-day {
  margin-top: 4px;
}

.btn--mini {
  padding: 3px 8px;
  font-size: 11px;
}

.btn--danger {
  border-color: var(--danger);
  color: var(--danger);
}

.btn--danger:hover {
  border-color: var(--danger);
  background: rgba(224, 74, 74, 0.08);
}
</style>
