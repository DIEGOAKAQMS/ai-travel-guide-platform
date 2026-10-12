import { config } from '../config'
import type { LlmGuide } from '../types'

/**
 * DeepSeek 客户端（流式）
 *
 * 关键点（实测得出）：
 *   1. deepseek-flash 是推理模型，响应里除 content 外还有 reasoning_content，
 *      且 reasoning 会消耗 max_tokens 配额（实测占输出 84%）。
 *      预算给少了 finish_reason='length' 且 content 直接是空串。
 *   2. 一次行程规划要跑 40~60 秒，全部静默等待体验极差，
 *      因此这里把 reasoning 增量实时抛给上层，由 SSE 推给前端做「思考中」反馈。
 */

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
}

export interface StreamDelta {
  reasoning?: string
  content?: string
}

interface ChatStreamResult {
  content: string
  finishReason: string
  usage: ChatUsage
}

/** 去掉模型可能附带的 markdown 代码块围栏 */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fence ? fence[1].trim() : trimmed
}

/** 单次流式请求：边收边抛增量，最后返回完整 content 与 usage */
async function callChatStream(
  system: string,
  user: string,
  maxTokens: number,
  onDelta: (delta: StreamDelta) => void,
): Promise<ChatStreamResult> {
  const response = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseek.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let content = ''
  let finishReason = ''
  const usage: ChatUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    // 最后一段可能是不完整行，留到下一轮
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue

      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      let chunk: {
        choices?: {
          finish_reason?: string | null
          delta?: { content?: string; reasoning_content?: string }
        }[]
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          completion_tokens_details?: { reasoning_tokens?: number }
        }
      }
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta

      if (delta?.reasoning_content) {
        onDelta({ reasoning: delta.reasoning_content })
      }
      if (delta?.content) {
        content += delta.content
        onDelta({ content: delta.content })
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason
      }
      if (chunk.usage) {
        usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens
        usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens
        usage.reasoningTokens =
          chunk.usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoningTokens
      }
    }
  }

  return { content, finishReason, usage }
}

/** 行程规划的系统提示词 */
export const GUIDE_SYSTEM_PROMPT = `你是资深自驾游与自由行行程规划师，服务于一家旅游攻略平台。

用户会给你一个地区或线路需求，你需要产出一份可直接落地执行的行程攻略。

【硬性要求】
1. 只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。
2. 绝对不要输出任何经纬度或坐标数字。坐标由系统后续通过地图服务检索，你提供坐标不仅无用，还会引入错误。
3. 行程要真实、具体、可执行。禁止编造不存在的地名。
4. 每日时间轴按实际游玩顺序排列，地理上顺路，不要来回折返；高原地区要考虑行车耗时，不要把行程排得过满。
5. 时间轴每天 5~9 个节点，需覆盖当天从出发到入住的关键环节（含赶路段）。
6. 【跨日必须首尾相接】第 N 天（N>1）的第一个节点，必须是第 N-1 天最后一个节点所在的同一地点。
   - 错误示例：第 1 天晚上住「四姑娘山镇」，第 2 天却从「成都」出发。
   - 正确示例：第 1 天最后节点是「四姑娘山镇住宿」，第 2 天第一个节点就是「四姑娘山镇出发」。
   - 每天最后一个节点都应是当晚住宿地（kind=town），并同时在 stay 字段写明住宿地。
7. 每天时间轴的第一个节点必须是当天的出发地，写成「地名 + 出发」，例如「西宁出发」「黑马河镇出发」，kind 填 drive。
   这里的「地名」必须是地图上真实可检索到的名称（城市 / 县城 / 乡镇，如 西宁、黑马河镇、大柴旦），
   系统会用它来定位当天第一段导航的起点；不要写「酒店出发」「住处出发」这类无法检索的说法。
   沿途的长距离移动也必须单独占一个 drive 节点（如「前往德令哈」），这类节点不需要真实地名。

【节点类型 kind 的用法】
- spot  景点（景区、寺庙、藏寨、湖泊等）
- view  观景台 / 垭口 / 观景点
- town  城镇 / 住宿点
- meal  用餐
- drive 赶路时段（纯路上）
- rest  休整 / 补给

【meal（用餐）节点必须带上可检索的地名】
- name 一律写成「地名 + 用餐时段」，例如「丹巴县城午餐」「稻城县晚餐」「泸定服务区午餐」。
- 这里的「地名」必须是地图上真实可检索到的城市 / 县城 / 乡镇 / 服务区 / 景区名，且是当天行程真正路过的地方；
  禁止只写「午餐」「晚餐」「用餐」「吃饭」这类系统无法定位的说法。
- 确知餐厅名字时写在括号里，如「丹巴县城午餐（藏家乐）」；系统会用括号外的地名定位，括号内的餐厅名只作展示。
- meal 节点必须填 city（写法见下），否则系统会完全定位不到，用餐点在时间轴和地图上都会是空的。

【city 字段的写法 —— 这直接决定地图能否定位】
- 只有「真实存在、能被地图检索到」的节点才填 city，格式为省市区县，例如 "四川省甘孜州稻城县"。
- kind 为 drive / rest 的节点，city 必须省略（它们不需要地图坐标）。
- kind 为 meal 的节点，city 必须填写。
- 其它类型若不确定，也可省略 city，但系统只能退回全省范围检索，命中率会明显下降。

【输出 JSON 结构】
{
  "title": "攻略标题",
  "region": "所在区域，如 川西",
  "summary": "整体概述，150 字以内",
  "total_days": 天数,
  "days": [
    {
      "day_index": 1,
      "title": "当天主题，如 成都 → 巴朗山 → 四姑娘山镇",
      "summary": "当天一句话概述，80 字以内",
      "route": "路线串联，如 成都 → 都江堰 → 巴朗山垭口 → 四姑娘山镇",
      "stay": "住宿地，如 四姑娘山镇（约 3200 m）",
      "highlights": "当日看点，60 字以内",
      "cautions": "当日注意事项或纪律，60 字以内",
      "drive_km": 220,
      "drive_hours": "4–5 h",
      "sleep_altitude_m": 3200,
      "max_altitude_m": 4480,
      "notes": ["当日提示一", "当日提示二"],
      "timeline": [
        {
          "time": "09:00",
          "name": "成都出发",
          "kind": "drive",
          "stay_minutes": 0,
          "priority": "normal",
          "desc": "走成灌高速往都江堰方向，路况良好。",
          "leg_km": 0
        },
        {
          "time": "11:00",
          "name": "都江堰景区",
          "kind": "spot",
          "city": "四川省成都市都江堰市",
          "stay_minutes": 180,
          "priority": "optional",
          "desc": "世界文化遗产，看鱼嘴、飞沙堰、宝瓶口三大主体工程。",
          "warnings": "赶行程可直接跳过，属于顺路加分项。",
          "tips": "登玉垒山可俯瞰整个水利工程全景。",
          "detail": "公元前 256 年李冰父子主持修建，是全世界至今仍在使用的无坝引水工程。鱼嘴把岷江分成内外两江，飞沙堰负责泄洪排沙，宝瓶口控制进水量，三者配合让成都平原水旱从人，才有了「天府之国」。景区内古木与秦堰楼、二王庙连成一片，边走边读两千年的治水智慧。",
          "highlights": ["鱼嘴分水堤看岷江分流", "二王庙俯瞰宝瓶口", "安澜索桥晃桥过岷江"],
          "best_time": "3–5 月、9–11 月水量与光线最好",
          "photo_keywords": ["都江堰景区 鱼嘴", "安澜索桥 岷江"],
          "leg_km": 60
        },
        {
          "time": "13:00",
          "name": "都江堰南桥午餐",
          "kind": "meal",
          "city": "四川省成都市都江堰市",
          "stay_minutes": 60,
          "priority": "normal",
          "desc": "南桥一带餐馆集中，吃碗渣渣面再继续赶路。",
          "detail": "南桥是都江堰的老码头口，桥廊下沿河一排馆子做的是本地家常味：渣渣面、葱葱卷、尤兔头、老腊肉炒鲜笋都值得点，价格比景区里实在。",
          "highlights": ["渣渣面", "葱葱卷", "尤兔头"],
          "leg_km": 0
        }
      ]
    }
  ]
}

【弹窗详情字段 —— 时间轴之外的第二套内容】
时间轴已经展示了玩法（desc）、避坑（warnings）、建议（tips）和时间安排，
下面这些字段只在地图上点开点位时的详情卡里展示，**内容必须与时间轴不重复**：
- detail          详细介绍 60~150 字。写这个地方（或这顿饭）的由来、背景、为什么值得来、有什么门道；
                  禁止复述 desc / warnings / tips 里的句子。
- highlights      看点 2~4 条短句（每条 6~18 字），写具体的东西：哪座雪峰、哪片林、哪道菜、哪个机位。不要写空话。
- best_time       最佳时段 / 季节，12 字以内（如「10 月中下旬彩林」「清晨 7–9 点无风倒影」）；不确定就省略。
- photo_keywords  1~3 个配图检索关键词，写成「地名 + 景观特征」（如「四姑娘山 双桥沟 红杉林」「丹巴 甲居藏寨 碉楼」），
                  系统会拿它去找实景照片；不要写「风景」「美景」这类泛词。
分类型的要求：
- spot / view：detail 写景观与人文背景，highlights 写具体的观景位置与机位，best_time 写光线 / 季节。
- meal：detail 写这一带的饮食特色与吃什么，highlights 写招牌菜 / 必点；best_time、photo_keywords 可省略。
- town：detail 写这一带住宿的特点与选房建议（如「尽量选县城东侧临河的高层，早上能看到河谷晨雾」）。
- drive / rest：上面四个字段全部省略。

【补充说明】
- desc 为玩法描述（40~80 字），warnings 为避坑提醒（没有就省略），tips 为实用建议（没有就省略）。
- detail / highlights / best_time / photo_keywords 是弹窗专用内容，见上一节，同样「没有就省略」。
- leg_km 是与上一节点之间的里程；当天第一个节点填 0。
- priority：key 表示关键/限时/高强度节点，optional 表示可选或季节限定，其余为 normal。
- 海拔类字段单位是米，按真实海拔填写。`

/** 改稿系统提示词：在保留原攻略的前提下按用户要求重写 */
export const GUIDE_REVISE_SYSTEM_PROMPT =
  GUIDE_SYSTEM_PROMPT +
  `

【本次是「改稿」而不是「重做」】
用户会给你一份「当前攻略 JSON」和一段「修改要求」，你需要输出修改后的完整攻略。
1. 只按修改要求改动相关部分，未提及的天、节点、文案、顺序尽量原样保留。
2. 输出仍然是完整的同结构 JSON（包含全部 days 与 timeline），不要只输出差异片段，不要输出任何解释文字。
3. 修改要求可能是：调整天数、增删/替换景点、调整顺序与时间、改住宿地、改每日主题或提示等，按语义照做。
4. 「当前攻略 JSON」里的 time / desc / warnings / tips / leg_km 等字段要与输出结构对齐，逐字沿用未改动的内容，不要凭空改写。
5. detail / highlights / best_time / photo_keywords 是弹窗详情内容：**未改动的节点必须原样沿用**，不要重写、不要省略，
   尤其不要把它们写成和 desc / warnings / tips 一样的句子。`

/** 组装用户消息 */
function buildUserMessage(prompt: string, extra?: { days?: number; region?: string }): string {
  const hints: string[] = []
  if (extra?.days) hints.push(`行程天数固定为 ${extra.days} 天。`)
  if (extra?.region) hints.push(`区域限定为 ${extra.region}。`)
  return hints.length > 0 ? `${prompt}\n\n补充要求：${hints.join('')}` : prompt
}

/**
 * 统一的「调用 → 校验 → 预算不足加倍重试」流程。
 * 预算不足导致 content 为空时自动加倍 max_tokens 重试。
 */
async function streamGuideWithRetry(
  system: string,
  user: string,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ guide: LlmGuide; usage: ChatUsage }> {
  let maxTokens = config.deepseek.maxTokens
  let lastUsage: ChatUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      onDelta({ reasoning: `\n\n[预算不足，已提升至 ${maxTokens} tokens 重试…]\n` })
    }

    const result = await callChatStream(system, user, maxTokens, onDelta)
    lastUsage = result.usage

    const text = stripFences(result.content)
    if (text) {
      try {
        const guide = JSON.parse(text) as LlmGuide
        if (Array.isArray(guide?.days) && guide.days.length > 0) {
          return { guide, usage: result.usage }
        }
        console.warn('[llm] 返回的 days 为空，将重试')
      } catch {
        console.warn('[llm] 返回内容不是合法 JSON，将重试')
      }
    } else {
      console.warn(
        `[llm] content 为空（finish_reason=${result.finishReason}，` +
          `reasoning 已消耗 ${result.usage.reasoningTokens} tokens），将加倍预算重试`,
      )
    }

    maxTokens *= 2
  }

  throw new Error(`DeepSeek 多次调用均未返回可用行程，lastUsage=${JSON.stringify(lastUsage)}`)
}

/** 生成行程骨架（不含坐标），推理过程实时回抛。 */
export async function planGuideStream(
  prompt: string,
  extra: { days?: number; region?: string } | undefined,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ guide: LlmGuide; usage: ChatUsage }> {
  return streamGuideWithRetry(GUIDE_SYSTEM_PROMPT, buildUserMessage(prompt, extra), onDelta)
}

/** 改稿：在现有攻略基础上按用户要求重写，输出同结构 JSON。 */
export async function reviseGuideStream(
  instruction: string,
  current: LlmGuide,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ guide: LlmGuide; usage: ChatUsage }> {
  const user = `【当前攻略 JSON】\n${JSON.stringify(current)}\n\n【修改要求】\n${instruction}`
  return streamGuideWithRetry(GUIDE_REVISE_SYSTEM_PROMPT, user, onDelta)
}
