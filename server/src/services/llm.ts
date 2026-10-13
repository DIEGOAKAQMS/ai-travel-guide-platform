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

/**
 * 推理增量的下发节流器。
 *
 * 推理模型一次会吐上万个 reasoning chunk，逐个走 SSE 既浪费带宽、
 * 也会把前端压垮。攒到 150ms 或 600 字符再发一次，事件量能降两三个数量级。
 */
function createDeltaGate(emit: (delta: StreamDelta) => void) {
  const FLUSH_MS = 150
  const FLUSH_CHARS = 600

  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!buffer) return
    const text = buffer
    buffer = ''
    emit({ reasoning: text })
  }

  return {
    push(text: string): void {
      buffer += text
      if (buffer.length >= FLUSH_CHARS) {
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, FLUSH_MS)
    },
    flush,
  }
}

/**
 * DEEPSEEK_EXTRA_BODY 的解析结果（缓存一份，解析失败就忽略）。
 * 用来试各家网关的「降低思考强度」开关，见 config.ts 里的说明。
 */
let cachedExtraBody: Record<string, unknown> | null = null
function deepseekExtraBody(): Record<string, unknown> {
  if (cachedExtraBody) return cachedExtraBody

  const raw = config.deepseek.extraBody
  if (!raw) {
    cachedExtraBody = {}
    return cachedExtraBody
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    cachedExtraBody =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
  } catch {
    console.warn('[llm] DEEPSEEK_EXTRA_BODY 不是合法 JSON，已忽略')
    cachedExtraBody = {}
  }
  return cachedExtraBody
}

/**
 * 思考强度参数。
 *
 * DeepSeek 的思考模式**默认开启且默认强度是 high**，一次生成光思考就能烧掉几分钟，
 * 所以这里按配置显式降档：
 *   off  → {"thinking":{"type":"disabled"}}  直接关掉思考，最快
 *   其它 → {"thinking":{"type":"enabled"},"reasoning_effort":<档位>}
 */
function reasoningBody(effort: string): Record<string, unknown> {
  if (!effort) return {}
  if (effort === 'off' || effort === 'none') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort }
}

/**
 * 按优先级合并请求体：全局额外参数 < 全局思考强度 < 任务级覆盖。
 *
 * 这里多处理一个坑：任务级把思考关掉时，必须把全局的 reasoning_effort 一并删掉。
 * 否则请求体里会同时出现 `thinking:{type:'disabled'}` 和 `reasoning_effort:'high'`，
 * 各家网关对这种自相矛盾的组合解释不一，有的会照旧按 high 思考
 * ——「clarify 明明关了思考却还是等很久」就是这么来的。
 */
function mergeRequestBody(extra: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...deepseekExtraBody(),
    ...reasoningBody(config.deepseek.reasoningEffort),
    ...extra,
  }
  const thinking = body.thinking as { type?: string } | undefined
  if (thinking && typeof thinking === 'object' && thinking.type === 'disabled') {
    delete body.reasoning_effort
  }
  return body
}

/** 单次流式请求：边收边抛增量，最后返回完整 content 与 usage */
async function callChatStream(
  system: string,
  user: string,
  maxTokens: number,
  onDelta: (delta: StreamDelta) => void,
  extra: Record<string, unknown> = {},
): Promise<ChatStreamResult> {
  const controller = new AbortController()
  let abortReason = ''

  /*
   * 超时自己管。
   *
   * 实测 AbortSignal.timeout 在「响应体正在被流式读取」期间不会可靠中断，
   * 请求能一直挂着不返回（于是就出现「等八分钟还没动静」）。
   * 这里显式用定时器 abort，并且分成两道：
   *   - 空闲超时：一阵子收不到任何数据 → 基本可以断定卡了
   *   - 总超时：  兜底的硬上限，防止它慢慢磨一整天
   */
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      abortReason = `超过 ${Math.round(config.deepseek.idleMs / 1000)} 秒没有收到任何输出`
      controller.abort()
    }, config.deepseek.idleMs)
  }
  armIdle()

  const totalTimer = setTimeout(() => {
    abortReason = `单次请求超过 ${Math.round(config.deepseek.totalMs / 1000)} 秒`
    controller.abort()
  }, config.deepseek.totalMs)

  const stopTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }

  let response: Response
  try {
    response = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
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
        // 优先级：全局额外参数 < 思考强度 < 任务级覆盖
        ...mergeRequestBody(extra),
      }),
      signal: controller.signal,
    })
  } catch (error) {
    stopTimers()
    if (abortReason) throw new Error(`DeepSeek 已中止：${abortReason}`)
    throw error
  }

  if (!response.ok || !response.body) {
    stopTimers()
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const gate = createDeltaGate(onDelta)

  let buffer = ''
  let content = ''
  let finishReason = ''
  const usage: ChatUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }

  for (;;) {
    const result = await reader.read().catch((error: unknown) => {
      stopTimers()
      gate.flush()
      if (abortReason) throw new Error(`DeepSeek 已中止：${abortReason}`)
      throw error
    })

    const { done, value } = result
    if (done) break

    // 收到数据说明模型还在往下吐，重置空闲计时
    armIdle()

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
        gate.push(delta.reasoning_content)
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

  stopTimers()
  // 收尾：把还没到点的推理尾巴发出去
  gate.flush()

  return { content, finishReason, usage }
}

/** 行程规划的系统提示词 */
export const GUIDE_SYSTEM_PROMPT = `你是资深自驾游与自由行行程规划师，服务于一家旅游攻略平台。

用户会给你一个地区或线路需求，你需要产出一份可直接落地执行的行程攻略。

【硬性要求】
1. 只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。
2. 绝对不要输出任何经纬度或坐标数字。坐标由系统后续通过地图服务检索，你提供坐标不仅无用，还会引入错误。
3. 行程要真实、具体、可执行。禁止编造不存在的地名：spot / view / town / meal 的 name 必须是地图上**确实能检索到的具名地点**
   （景区、寺庙、村镇、服务区全名）。不要写「喇荣沟观景台」「雅砻江大峡谷观景台」这类自己拼出来的名字 ——
   系统会拿它去地图上搜，搜不到时会退而求其次匹配到几百公里外的相似地点，一整天的行程都会因此错位。
   拿不准就换成确实存在的地点（如「喇荣五明佛学院」「甘孜县城」）。
4. 每日时间轴按实际游玩顺序排列，地理上顺路，不要来回折返；高原地区要考虑行车耗时，不要把行程排得过满。
   用户需求里给了每天的车程上限时，指的是**单日累计**行车时间（当天所有相邻节点之间的行车时长相加，
   不是单段上限）；某天累计会超上限，就砍掉一个点或换成更近的替代点再排。
5. 时间轴每天 5~9 个节点，需覆盖当天从出发到入住的关键环节（含赶路段）。
6. 【跨日必须首尾相接】第 N 天（N>1）的第一个节点，必须是第 N-1 天最后一个节点所在的同一地点。
   - 错误示例：第 1 天晚上住「四姑娘山镇」，第 2 天却从「成都」出发。
   - 正确示例：第 1 天最后节点是「四姑娘山镇住宿」，第 2 天第一个节点就是「四姑娘山镇出发」。
   - 每天最后一个节点都应是当晚住宿地（kind=town），并同时在 stay 字段写明住宿地。
7. 每天时间轴的第一个节点必须是当天的出发地，写成「地名 + 出发」，例如「西宁出发」「黑马河镇出发」，kind 填 drive。
   这里的「地名」必须是地图上真实可检索到的名称（城市 / 县城 / 乡镇，如 西宁、黑马河镇、大柴旦），
   系统会用它来定位当天第一段导航的起点；不要写「酒店出发」「住处出发」这类无法检索的说法。
   **「地名」必须与前一晚住宿节点的地名逐字一致、不要简写**：前一晚写「甘孜县城住宿」，次日就写「甘孜县城出发」。
   简写成「甘孜」会被地图定位到 180 km 外的康定 —— 「甘孜」既是甘孜州（州府在康定）又是甘孜县，
   同理还有「阿坝」（州府马尔康 vs 阿坝县）、「玉树」这类州名与县名同名的地名。
   沿途的长距离移动也必须单独占一个 drive 节点（如「前往德令哈」），这类节点不需要真实地名。
8. 【出发时间是「尽量」，不是死约束】用户写「尽量 9 点出发」「不想起太早」是**期望**，默认把当天首站的 time 排在用户期望的时段。
   但下面这些情况允许（也应该）适当提前，一般提前 1~2 小时即可，不必一路提到凌晨：
   - 当天要看日出 / 晨雾 / 日照金山这类只在清晨出现的景色；
   - 当天是长距离赶路，晚出发会摸黑赶路、后段全耗在夜里；
   - 当天景点体量大，要赶在日落 / 闭园前走完。
   提前了就把原因写进当天首个节点的 desc（如「今日要看日照金山，提前到 6:30 出发」），让用户一眼看懂这天为什么比别的天早。
   用户完全没提出发时间时，才按常规时段（07:00 出发、21:00 前结束）来排。
9. 【同一地点分两次游览要写明区别】同一景点可以在不同时段各去一次（例如「抵达日傍晚看夜景 + 次日早上转经」），这不算重复。
   但两处节点的 name 必须写清各自的时段或目的，如「喇荣五明佛学院（傍晚看红房子）」「喇荣五明佛学院（上午转经）」，
   禁止两处都只写同一个光秃秃的地名 —— 那样在时间轴上看起来就像排重了。
   定位只用括号外的地名，所以括号外的地名要照常写全、写准（沿用【meal】一节的括号写法）。

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
          "desc": "走成灌高速往都江堰方向，路况良好。"
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
          "photo_keywords": ["都江堰景区 鱼嘴", "安澜索桥 岷江"]
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
          "highlights": ["渣渣面", "葱葱卷", "尤兔头"]
        }
      ]
    }
  ]
}

- 逐段里程与耗时（leg_km / distance / duration）由系统按真实路线数据回填，不由你提供。

【弹窗详情字段 —— 时间轴之外的第二套内容】
时间轴已经展示了玩法（desc）、避坑（warnings）、建议（tips）和时间安排，
下面这些字段只在地图上点开点位时的详情卡里展示，**内容必须与时间轴不重复**：
- detail          详细介绍 60~120 字。写这个地方（或这顿饭）的由来、背景、为什么值得来、有什么门道；
                  禁止复述 desc / warnings / tips 里的句子。**宁短勿长**：60 字已说清就停，不要凑字数。
- highlights      看点 2~3 条短句（每条 6~18 字），写具体的东西：哪座雪峰、哪片林、哪道菜、哪个机位。不要写空话。
- best_time       最佳时段 / 季节，12 字以内（如「10 月中下旬彩林」「清晨 7–9 点无风倒影」）；不确定就省略。
- photo_keywords  1~3 个配图检索关键词，写成「地名 + 景观特征」（如「四姑娘山 双桥沟 红杉林」「丹巴 甲居藏寨 碉楼」），
                  系统会拿它去找实景照片；不要写「风景」「美景」这类泛词。
分类型的要求：
- spot / view：detail 写景观与人文背景，highlights 写具体的观景位置与机位，best_time 写光线 / 季节。
- meal：detail 写这一带的饮食特色与吃什么（40~70 字即可），highlights 写招牌菜 / 必点；best_time、photo_keywords 可省略。
- town：detail 写住宿特点与选房建议（40~80 字，如「选县城东侧临河的高层，早上能看到河谷晨雾」）。
- drive / rest：上面四个字段全部省略。

【补充说明】
- desc 为玩法描述，40~80 字，必写。
- warnings 是避坑提醒（40 字以内），tips 是实用建议（30 字以内，如「门票便宜、排队快，半小时足够，不用专门预留太多时间」）。
  这两个是时间轴上会**原样展示**的「提醒 / 建议」，是整份攻略里最有用的部分：只要有值得说的就写，
  大多数景点和用餐点都应该有一条。确实没得说可以省略，但不要因为"能省"就把整份都省掉。
- detail / highlights / best_time / photo_keywords 是弹窗专用内容，见上一节，同样「没有就省略」。
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
4. 「当前攻略 JSON」里的 time / desc / warnings / tips 等字段要与输出结构对齐，逐字沿用未改动的内容，不要凭空改写。
5. detail / highlights / best_time / photo_keywords 是弹窗详情内容：**未改动的节点必须原样沿用**，不要重写、不要省略，
   尤其不要把它们写成和 desc / warnings / tips 一样的句子。`

/** 组装用户消息 */
function buildUserMessage(prompt: string, extra?: { days?: number; region?: string }): string {
  const hints: string[] = []
  if (extra?.days) hints.push(`行程天数固定为 ${extra.days} 天。`)
  if (extra?.region) hints.push(`区域限定为 ${extra.region}。`)
  return hints.length > 0 ? `${prompt}\n\n补充要求：${hints.join('')}` : prompt
}

interface StreamRetryOptions {
  /** 初始输出预算；不传则取 config 里的默认值 */
  maxTokens?: number
  /**
   * 最多尝试几次（含首次），默认 4（= 首次 + 3 次重试）。
   *
   * 每重试一次预算翻倍，所以预算是按 1 → 2 → 4 → 8 倍往上给的，
   * 宁可多试几次也不让一次生成白白失败。代价是失败场景下等待会明显变长
   * （单次上限见 DEEPSEEK_TOTAL_MS），用户随时可以点「停止」中止。
   */
  attempts?: number
  /** 追加进请求体的参数（优先级最高），用于按任务单独调思考强度等 */
  extra?: Record<string, unknown>
}

/**
 * 统一的「调用 → 校验 → 预算不够再试一次」流程。
 *
 * accept 负责把解析出来的 JSON 转换成目标结构；返回 null 表示结构不合用，
 * 与「content 为空」一样会被判为需要重试。
 *
 * 注意：**网络错误 / 超时 / HTTP 错误一律不重试，直接往上抛**。
 * 这类错误重试只会让用户干等的时间成倍增加 —— 之前「一次生成等十几分钟」
 * 就是这么来的：5 分钟超时 × 3 次重试 × 预算翻倍。
 */
async function streamJsonWithRetry<T>(
  system: string,
  user: string,
  accept: (value: unknown) => T | null,
  onDelta: (delta: StreamDelta) => void,
  options: StreamRetryOptions = {},
): Promise<{ value: T; usage: ChatUsage }> {
  const attempts = Math.max(1, options.attempts ?? 4)
  let maxTokens = options.maxTokens ?? config.deepseek.maxTokens
  let lastUsage: ChatUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      // 把「第几次 / 共几次」也带上：重试次数多了以后，用户需要知道还要等几轮
      onDelta({
        reasoning:
          `\n\n[第 ${attempt + 1}/${attempts} 次尝试：上次没能返回完整结果，` +
          `已提升至 ${maxTokens} tokens 重试…]\n`,
      })
    }

    // 刻意不 catch：超时、网络中断、HTTP 错误直接抛给上层，
    // 让用户马上看到失败原因，而不是默默再等一遍
    const result = await callChatStream(system, user, maxTokens, onDelta, options.extra)
    lastUsage = result.usage

    // reasoning 与 content 共用 max_tokens，所以「预算不够」有两种表现：
    //   1. 额度全被思考吃光 → content 是空串
    //   2. 正文写到一半被截断 → finish_reason=length、JSON 解析失败
    // 两者都该当成「给的钱不够」，而不是「内容不对」。
    const spentAllOnReasoning = result.usage.reasoningTokens >= maxTokens
    const budgetExhausted = result.finishReason === 'length' || spentAllOnReasoning

    const text = stripFences(result.content)
    if (text) {
      try {
        const value = accept(JSON.parse(text))
        if (value !== null) return { value, usage: result.usage }
        console.warn('[llm] 返回结构与预期不符，将再试一次')
      } catch {
        console.warn(
          '[llm] 返回内容不是合法 JSON' +
            (budgetExhausted ? `（finish_reason=length，正文被 max_tokens=${maxTokens} 截断）` : '') +
            '，将再试一次',
        )
      }
    } else {
      console.warn(
        `[llm] content 为空（finish_reason=${result.finishReason}，` +
          `reasoning 消耗 ${result.usage.reasoningTokens}/${maxTokens} tokens）` +
          (spentAllOnReasoning ? '：额度全被思考吃光' : ''),
      )
    }

    // 预算不够就翻倍，**不设上限**：这是「让它把活干完」的兜底，不是省钱的地方。
    // 唯一约束是尝试次数（attempts），不会无限跑下去。
    maxTokens = budgetExhausted ? maxTokens * 2 : Math.round(maxTokens * 1.5)
  }

  throw new Error(`DeepSeek 多次调用均未返回可用结果，lastUsage=${JSON.stringify(lastUsage)}`)
}

/** 校验「整份行程」结构：days 必须是非空数组 */
function acceptGuide(value: unknown): LlmGuide | null {
  const guide = value as LlmGuide
  if (Array.isArray(guide?.days) && guide.days.length > 0) return guide
  console.warn('[llm] 返回的 days 为空，将重试')
  return null
}

/** 生成行程骨架（不含坐标），推理过程实时回抛。 */
export async function planGuideStream(
  prompt: string,
  extra: { days?: number; region?: string } | undefined,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ guide: LlmGuide; usage: ChatUsage }> {
  const { value: guide, usage } = await streamJsonWithRetry(
    GUIDE_SYSTEM_PROMPT,
    buildUserMessage(prompt, extra),
    acceptGuide,
    onDelta,
  )
  return { guide, usage }
}

/** 改稿：在现有攻略基础上按用户要求重写，输出同结构 JSON。 */
export async function reviseGuideStream(
  instruction: string,
  current: LlmGuide,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ guide: LlmGuide; usage: ChatUsage }> {
  const user = `【当前攻略 JSON】\n${JSON.stringify(current)}\n\n【修改要求】\n${instruction}`
  const { value: guide, usage } = await streamJsonWithRetry(
    GUIDE_REVISE_SYSTEM_PROMPT,
    user,
    acceptGuide,
    onDelta,
  )
  return { guide, usage }
}

// ---------------------------------------------------------------------------
// 时间轴重排：只允许调整「顺序 / 所属天 / 到达时间」，禁止增删节点
// ---------------------------------------------------------------------------

/** 送给模型的单个节点（带真实坐标，便于它判断地理关系） */
export interface ReplanNodeInput {
  id: string
  name: string
  kind: string
  time?: string
  stay_minutes?: number
  lng?: number
  lat?: number
  /** 用户刚加进来、还没填停留时长的节点：唯一允许模型补全信息的节点 */
  fill_stay?: boolean
}

export interface ReplanDayInput {
  day_index: number
  nodes: ReplanNodeInput[]
}

/** 模型输出的重排方案：只有 id、建议时间，以及新节点的补全信息 */
export interface ReplanPlan {
  days: {
    day_index: number
    nodes: { id: string; time?: string; stay_minutes?: number; tips?: string }[]
  }[]
}

export const GUIDE_REPLAN_SYSTEM_PROMPT = `你是资深自驾游与自由行行程规划师。
用户刚改动了行程时间轴上的一部分内容，现在只让你做一件事：
在**给定的这几天**里，重新安排节点的**先后顺序、归属哪一天、以及到达时间**。

【绝对禁止 —— 违反即视为任务失败】
1. 禁止新增节点：输出里的 id 只能来自输入，一个都不能多。
2. 禁止删除节点：输入里的每一个 id 都必须原样出现在输出里，一个都不能少。
3. 禁止改动节点本身的任何信息（名称、类型、坐标都不要动）。唯一例外是标了 "fill_stay": true 的节点 ——
   那是用户刚加进来、还没填停留时长的点，按【补全新节点】给它补上 stay_minutes 与 tips。
4. 只处理输入里给出的这些天。没出现在输入里的天，你看不到也不要提，更不要把节点搬过去。
5. 只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。

【出发时间：遵从用户偏好，但也允许适当提前】
- 【用户需求】里的出发时间是**期望**（用户常写「尽量 9 点出发」「不想起太早」），不是死规矩；默认按期望的时段排当天首站。
- 但下面这些情况可以（也应该）适当提前，一般提前 1~2 小时即可，不必一路提到凌晨：
  · 当天要看日出 / 晨雾 / 日照金山这类只在清晨出现的景色；
  · 当天是长距离赶路，晚出发会摸黑赶路、后段全耗在夜里；
  · 当天景点体量大，要赶在日落 / 闭园前走完。
- 用户完全没提出发时间时，才按常规时段（07:00 出发、21:00 前结束）来排。

【你可以做的】
- 调整同一天内节点的先后顺序，让路线顺路、不来回折返。
- 把节点从一天挪到另一天（例如某天太赶、某天太空），但只能在这些天之间挪，天本身不增不减，day_index 沿用输入里已有的值。
- 调整每天的到达时间（time，格式 'HH:mm'），让当天行程落在合理的时段内（出发时间见上【出发时间】）。
- 用户需求里给了每天的车程上限时，指的是**单日累计**行车时间（不是单段上限）；排不下就把节点挪到别的天或压缩停留时长。
- 结合坐标判断地理关系：同一天相邻的节点应该是顺路的；高原长距离赶路段要给足行车时间，不要把时刻排得过密。
- 每天的最后一个节点与次日的第一个节点应当地理衔接（当晚住宿地 = 次日出发地附近）。

【补全新节点】
- 只有标了 "fill_stay": true 的节点才输出 stay_minutes 与 tips，其它节点一律不要输出这两个字段。
- stay_minutes 是**大致停留分钟数**（整数），按点位体量给：大景区（稻城亚丁、九寨沟这种能玩半天的）120~240，
  普通景点 / 古镇 / 寺庙 45~90，垭口 / 观景台 15~30，吃饭 45~60，休整 30~60。
  新节点加进来会挤占后面站点的时刻，把当天的到达时间一起往后顺延，别把一天排爆。
- tips 是一句 20 字以内的可操作建议（如「建议坐观光车到牛场再徒步」）。

【输出 JSON 结构】
{
  "days": [
    { "day_index": 1, "nodes": [ { "id": "节点id", "time": "08:30" }, { "id": "节点id", "time": "10:10", "stay_minutes": 90, "tips": "建议坐观光车到牛场再徒步" } ] }
  ]
}
- days 只需覆盖输入里给出的那些天（可用 day_index 相同的多个对象，也可合并写在一处）。
- nodes 按你决定的先后顺序排列。
- time 为建议到达时间；不确定就省略，省略表示沿用原时间。`

/** 校验并归一化重排方案 */
function acceptReplanPlan(value: unknown): ReplanPlan | null {
  const plan = value as ReplanPlan
  if (!Array.isArray(plan?.days) || plan.days.length === 0) return null
  const days = plan.days
    .filter((day) => day && Array.isArray(day.nodes))
    .map((day) => ({
      day_index: Number(day.day_index),
      nodes: day.nodes
        .filter((node) => node && node.id !== undefined && node.id !== null)
        .map((node) => ({
          id: String(node.id),
          time: node.time ? String(node.time) : undefined,
          // 只有新节点需要补全；这两个字段由服务端按白名单二次校验后才落库
          stay_minutes: Number.isFinite(Number(node.stay_minutes))
            ? Number(node.stay_minutes)
            : undefined,
          tips: node.tips ? String(node.tips) : undefined,
        })),
    }))
    .filter((day) => Number.isFinite(day.day_index))
  return days.length > 0 ? { days } : null
}

/**
 * 让模型重新编排时间轴。
 *
 * 传给模型的「天 + 节点」结构里每个节点都带 id，模型只回 id 与时间，
 * 因此服务端可以严格保证「节点不增不减」。
 *
 * `requirement` 是用户最初的需求 + 澄清答案：**必须带上**，
 * 否则模型不知道「尽量 9 点出发」「每天最多 6 小时车程」这类偏好 / 约束，
 * 会把首站的出发时间一律按默认"合理时段"改掉（实测坑：用户要求尽量 9 点出发，
 * 重排后 10 天全被改成 7:30，该早起看日出的日子也一样）。
 */
export async function replanGuideStream(
  days: ReplanDayInput[],
  onDelta: (delta: StreamDelta) => void,
  requirement?: string,
): Promise<{ plan: ReplanPlan; usage: ChatUsage }> {
  const asked = requirement?.trim()
  const user = asked
    ? `【用户需求】\n${asked}\n\n【当前行程节点】\n${JSON.stringify({ days })}`
    : `【当前行程节点】\n${JSON.stringify({ days })}`
  const { value: plan, usage } = await streamJsonWithRetry(
    GUIDE_REPLAN_SYSTEM_PROMPT,
    user,
    acceptReplanPlan,
    onDelta,
    // 输出本身只有「id + 时间」，用不了多少；起步值给 16384 是为了给推理留足余量
    // （重排要权衡顺路性与跨天衔接，思考容易被 4096 顶掉，导致正文写不出来）。
    // 这只是上限，模型用不到就不会花；真被截断仍会自动翻倍。
    { maxTokens: 16384 },
  )
  return { plan, usage }
}

// ---------------------------------------------------------------------------
// 生成前置提问：先问清关键信息，再动手排行程
// ---------------------------------------------------------------------------

export interface ClarifyQuestion {
  question: string
  /** 常见选项；用户也可以自己填 */
  options: string[]
  /** 是否可多选（「想去的景点」这类题会给 true） */
  multiple?: boolean
}

export interface ClarifyPlan {
  questions: ClarifyQuestion[]
}

export const GUIDE_CLARIFY_SYSTEM_PROMPT = `你是资深自驾游与自由行行程规划师。
用户刚给出一个初步的出行想法，信息往往不够具体。直接排行程会有大量地方靠猜，排出来也多半不合用。
所以你的任务是：**先向用户提问**，把真正影响行程走向的信息问清楚。

【要求】
1. 只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。
2. 提 3~5 个问题。每个问题都必须是「不问清楚就排不好行程」的硬信息，例如：
   - 出发地与进出方式（飞到哪儿 / 自己开车）
   - 具体日期与天数
   - 同行情况（几个人、有没有老人小孩、是否情侣、开几台车）
   - 每天能接受的**累计**车程上限（单日最多开几小时 / 多少公里，不是一个点到下一个点的上限）
   - 必去的点、必须避开的点
   - 预算与住宿标准
   - 是否有高反顾虑、是否需要徒步或越野路段
3. 不要问用户原话里已经说清楚的信息，也不要问「你想去哪玩」这类泛泛的问题。
4. 每个问题配 2~4 个常见选项（options），让用户能一键选，同时也能自己填；只有下面那两道景点题可以给到 3~6 个。
5. 问题要短（20 字以内），用口语问，不要「请问您是否希望……」这种客套。
6. 最后一个问题固定问「还有别的特别要求吗」，options 固定为 ["没有，按常规来"]。
7. 必须固定包含一道「想去的景点」题（第 3 条不适用于它）：问用户有没有非去不可的地方，问法随目的地变化，
   如「川西这一路有特别想去的景点吗」。
   - options 要从用户提到的目的地里挑 3~6 个**真实存在、地图上搜得到的景点名**（写景区全名，如「稻城亚丁」「四姑娘山」「泸沽湖」），
     让人一眼能挑；不要写「某某沿途风光」这类检索不到的说法。
   - 该问题的 JSON 里必须带 "multiple": true，表示可以多选；选项别写成穷举，用户也可能自己补别的点。
   - 顺便也放一个 "都行，你安排" 之类的选项，用户没有偏好时可以一键表态。
8. 「不想去的景点」这道题按需问：目的地里有明显不适合所有人、容易踩坑的点（高反重、徒步强度大、季节不对）
   就顺带问一句，如「这几个点里有你不想去或者想避开的吗」；用户已经说得很清楚或行程很宽松时可以省略。
   - 问的话 options 给 3~5 个该目的地里最常见、真实可检索的景点名（与上一题可以是同一批 —— 「不想去」往往正是
     那些耳熟能详但不适合这次的），末尾放一个 "没有，都可以" 方便一键表态；
   - 该问题带 "multiple": true。
   - 「想去」与「不想去」要分成两道题，不要合成一道：用户才能两边都表态，排行程时也才知道哪些是「务必安排」、
     哪些是「务必避开」。
9. 这些都是选答题，用户可以只答一部分、甚至一个都不答。不要写「必答」「请务必填写」这类字样，
   也不要为了凑数硬问 —— 问得越少越准，用户答得越省事。

【输出 JSON 结构】
{
  "questions": [
    { "question": "从哪个城市出发？", "options": ["成都", "西宁", "乌鲁木齐"] },
    { "question": "一共玩几天？", "options": ["5 天", "7 天", "10 天"] },
    { "question": "川西这边有特别想去的景点吗？", "options": ["稻城亚丁", "四姑娘山", "贡嘎雪山", "色达"], "multiple": true },
    { "question": "有不想去或者要避开的地方吗？", "options": ["色达", "稻城亚丁", "四姑娘山", "没有，都可以"], "multiple": true }
  ]
}`

/** 校验并归一化澄清问题列表 */
function acceptClarifyPlan(value: unknown): ClarifyPlan | null {
  const plan = value as ClarifyPlan
  if (!Array.isArray(plan?.questions)) return null

  const questions: ClarifyQuestion[] = []
  // 上面 6 条是硬要求（含「想去 / 不想去」两道景点题与收尾那题），留点余量免得被截掉尾巴
  for (const item of plan.questions.slice(0, 8)) {
    const question = String((item as ClarifyQuestion)?.question ?? '').trim()
    if (!question) continue
    // 景点题允许多选，选项也就允许多给几个，方便把当地的关键景点都摆出来
    const multiple = (item as ClarifyQuestion)?.multiple === true
    const rawOptions = (item as ClarifyQuestion)?.options
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .map((option) => String(option ?? '').trim())
          .filter((option) => option.length > 0)
          .slice(0, multiple ? 8 : 4)
      : []
    questions.push({ question, options, multiple })
  }

  if (questions.length === 0) {
    console.warn('[llm] 未产出可用的澄清问题，将重试')
    return null
  }
  return { questions }
}

/** 生成攻略前反问用户：只回 JSON 问题列表，推理过程实时回抛 */
export async function clarifyGuideStream(
  prompt: string,
  onDelta: (delta: StreamDelta) => void,
): Promise<{ plan: ClarifyPlan; usage: ChatUsage }> {
  const { value: plan, usage } = await streamJsonWithRetry(
    GUIDE_CLARIFY_SYSTEM_PROMPT,
    `【用户的想法】\n${prompt}`,
    acceptClarifyPlan,
    onDelta,
    {
      maxTokens: 2048,
      // 「该问用户哪些问题」不需要深度推理，默认关掉思考最快；
      // 想让它也走深思，改 DEEPSEEK_CLARIFY_REASONING_EFFORT 即可。
      extra: reasoningBody(config.deepseek.clarifyReasoningEffort),
    },
  )
  return { plan, usage }
}
