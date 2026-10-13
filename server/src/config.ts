import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseEnv } from 'dotenv'

/**
 * 分层加载配置。
 *
 * 为什么不用 `import 'dotenv/config'`：它只读 server/.env，而项目里所有
 * 「要花钱」的配置现在集中在仓库根目录的 config.env（见该文件顶部说明）。
 * 这里有三个必须同时满足的约束：
 *   1. config.env 要能覆盖两个历史 .env —— 用户只改这一个文件就该生效；
 *   2. 历史 .env 仍要可用，老部署不该因为这次改动直接起不来；
 *   3. 外部注入的真实环境变量（docker / CI）优先级最高。
 * 因此按「低 → 高」依次合并，并规定**空值一律视为未设置**，让下层继续兜底。
 */
const SERVER_DIR = resolve(__dirname, '..')
const ROOT_DIR = resolve(SERVER_DIR, '..')

/** 统一配置文件（用户日常编辑的唯一文件，位于仓库根目录） */
export const CONFIG_FILE = resolve(ROOT_DIR, 'config.env')

const FILE_LAYERS = [
  resolve(SERVER_DIR, '.env'), // 最低：历史后端配置
  resolve(ROOT_DIR, '.env'), // 历史前端配置（也放了少量后端项）
  CONFIG_FILE, // 最高：统一配置文件
]

function loadFileEnv(): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const path of FILE_LAYERS) {
    if (!existsSync(path)) continue
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      if (value && value.trim()) merged[key] = value.trim()
    }
  }
  return merged
}

const FILE_ENV = loadFileEnv()

// 回写进 process.env：仓库里有脚本直接读 process.env（如 scripts/*.ts）。
// 只补真正缺失的键，绝不覆盖外部注入的真实环境变量。
for (const [key, value] of Object.entries(FILE_ENV)) {
  if (!process.env[key] || !process.env[key]!.trim()) process.env[key] = value
}

/** 取配置值：外部环境变量 > 三个配置文件 > 未设置 */
function envValue(name: string): string | undefined {
  const fromProcess = process.env[name]
  if (fromProcess && fromProcess.trim()) return fromProcess.trim()
  return FILE_ENV[name]
}

function required(name: string): string {
  const value = envValue(name)
  if (!value) {
    throw new Error(
      `缺少必需的环境变量 ${name}，请在仓库根目录的 config.env 中配置（该文件有逐项说明）`,
    )
  }
  return value
}

function optional(name: string, fallback: string): string {
  return envValue(name) ?? fallback
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '5300')),

  db: {
    host: optional('PGHOST', '127.0.0.1'),
    port: Number(optional('PGPORT', '5432')),
    user: optional('PGUSER', 'postgres'),
    password: optional('PGPASSWORD', ''),
    database: optional('PGDATABASE', 'travel_guide'),
    max: 10,
  },

  deepseek: {
    apiKey: required('DEEPSEEK_API_KEY'),
    baseUrl: optional('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: optional('DEEPSEEK_MODEL', 'deepseek-flash'),
    /**
     * 默认输出预算（含 reasoning token）。
     *
     * 推理模型不仅把 reasoning 算进这份额度，而且**和正文共用同一份预算**，
     * 所以这个值必须按「长思考 + 整份 JSON 正文」来给：
     * 7 天攻略的正文本身就约 11.5k tokens（库里 raw_llm 实测），长思考一次能烧掉 24k+。
     * 10 天攻略实测：reasoning 29k + 正文 18.7k = 47.8k tokens，**一次调用就要这么多**。
     * 给 8192 / 16384 / 32768 的后果是 reasoning 先把额度吃光 —— 正文要么是空串、
     * 要么写到一半被截断（finish_reason=length），任务必然失败。
     * 而 32768 起步时 10 天攻略**每跑必失败一次**：首轮跑满 181 秒被截断丢弃、
     * 翻倍重试才成功，等于把 8 分钟的生成白白拖长 3 分钟，所以起步值必须 ≥ 65536。
     * 各任务另在调用处按需覆盖（见 llm.ts）：重排 16384、提问 2048。
     */
    maxTokens: Number(optional('DEEPSEEK_MAX_TOKENS', '65536')),
    /**
     * 思考强度：low / high / max，或 off 直接关闭思考。
     *
     * 这里用官方默认档 high：排程要考虑跨天衔接、高原行车耗时、地理顺路性，
     * 思考深度直接影响这几件事的合理性，宁可慢一点也要排得对。
     * （官方映射表里 medium 会被归到 high，所以实际只有三档。）
     *
     * 嫌慢可以降档，改这一个环境变量即可：
     *   DEEPSEEK_REASONING_EFFORT=low    明显提速，复杂线路会略粗糙
     *   DEEPSEEK_REASONING_EFFORT=off    最快，质量下降较明显
     */
    reasoningEffort: optional('DEEPSEEK_REASONING_EFFORT', 'high'),
    /**
     * 澄清提问（正式排行程前的反问）用的思考强度。
     *
     * 默认 off：这一步只是产出「还需要向用户确认哪些信息」，用不着深度推理，
     * 关掉思考能明显加快出题速度。想让它也走深思就设成 high。
     */
    clarifyReasoningEffort: optional('DEEPSEEK_CLARIFY_REASONING_EFFORT', 'off'),
    /**
     * 空闲超时（毫秒）：多久没收到任何数据就判定卡死。
     *
     * 用「空闲」而不是「总时长」作为判据，是因为只要模型还在往外吐字就
     * 说明它在干活，不该被打断。
     */
    idleMs: Number(optional('DEEPSEEK_IDLE_MS', '60000')),
    /**
     * 总超时（毫秒）：一次请求的硬上限，兜底防止无限拖下去。
     *
     * 要按最大预算来给：65536 tokens 的响应按实测吞吐（约 180 tokens/s）得跑 6 分钟左右，
     * 卡在 5 分钟会把本来能成功的大预算生成直接砍掉（超时不重试，白等）。
     * 真正卡死的请求由空闲超时（idleMs）负责兜。
     */
    totalMs: Number(optional('DEEPSEEK_TOTAL_MS', '600000')),
    /**
     * 追加进请求体的额外参数（JSON 字符串），用来试各家网关的「降低思考强度」开关。
     *
     * 不同网关参数名不一样，所以不写死，留个口子按需配，例如：
     *   DEEPSEEK_EXTRA_BODY={"reasoning_effort":"low"}
     *   DEEPSEEK_EXTRA_BODY={"thinking":{"type":"disabled"}}
     *   DEEPSEEK_EXTRA_BODY={"enable_thinking":false}
     * 留空则不追加任何字段。
     */
    extraBody: optional('DEEPSEEK_EXTRA_BODY', ''),
  },

  amap: {
    key: required('AMAP_KEY'),
    baseUrl: 'https://restapi.amap.com',
    /**
     * 两次高德请求之间的最小间隔（毫秒）。
     * 高德对并发 QPS 有硬限制，实测并发请求会触发
     * 10021 CUQPS_HAS_EXCEEDED_THE_LIMIT，故强制串行 + 限速。
     */
    minIntervalMs: Number(optional('AMAP_MIN_INTERVAL_MS', '350')),
  },

  tianditu: {
    token: optional('TIANDITU_TOKEN', ''),
    geocoderUrl: 'https://api.tianditu.gov.cn/geocoder',
  },
}

/**
 * 区域包围盒，用于校验地理编码结果是否越界。
 * 格式 [minLng, minLat, maxLng, maxLat]
 * 背景：天地图把「理塘」解析到了 120.4°E（浙江），score 仍是 99；
 * 高德的结构化地理编码会把「阿斯哈图石林」解析到云南石林、「热水塘」解析到云南保山，
 * 只能靠 bbox 兜住这类假阳性。
 */
export const REGION_BBOX: Record<string, [number, number, number, number]> = {
  川西: [97, 27, 104.5, 34],
  四川: [97, 26, 108.6, 34.4],
  云南: [97.5, 21, 106.2, 29.3],
  西藏: [78, 26.8, 99.2, 36.5],
  甘肃: [92, 32, 108.8, 42.8],
  青海: [89.4, 31.6, 103.1, 39.3],
  新疆: [73.5, 34.3, 96.4, 49.2],
  贵州: [103.6, 24.6, 109.6, 29.2],
  内蒙古: [97.1, 37.4, 126.1, 53.4],
  河北: [113.4, 36, 119.9, 42.6],
  北京: [115.4, 39.4, 117.5, 41.1],
  天津: [116.7, 38.5, 118.1, 40.3],
  山西: [110.2, 34.6, 114.6, 40.8],
  陕西: [105.5, 31.7, 111.3, 39.6],
  宁夏: [104.2, 35.2, 107.7, 39.4],
  山东: [114.8, 34.4, 122.8, 38.4],
  河南: [110.4, 31.4, 116.7, 36.4],
  湖北: [108.3, 29, 116.1, 33.3],
  湖南: [108.8, 24.6, 114.3, 30.1],
  江苏: [116.4, 30.8, 121.9, 35.1],
  浙江: [118, 27.1, 123, 31.2],
  安徽: [114.9, 29.4, 119.6, 34.6],
  福建: [115.8, 23.5, 120.5, 28.3],
  江西: [113.6, 24.5, 118.5, 30.1],
  广东: [109.7, 20.2, 117.3, 25.5],
  广西: [104.4, 20.9, 112.1, 26.4],
  海南: [108.6, 18.1, 111.1, 20.2],
  重庆: [105.3, 28.2, 110.2, 32.2],
  东北: [118.8, 38.6, 135.1, 53.6],
  中国: [73, 3, 136, 54],
}

/**
 * 区域名 → bbox 的别名表。
 *
 * LLM 写的 region 五花八门（「内蒙古赤峰·乌兰布统」「滇西北」「川西」…），
 * 之前只按 9 个 key 做 includes 匹配，认不出就直接退化成中国范围 ——
 * 等于把越界校验整体关掉（乌兰布统那条攻略的「阿斯哈图石林」就是被当成 ok 收进了云南石林）。
 */
export const REGION_ALIASES: Record<string, string[]> = {
  川西: ['川西', '甘孜', '阿坝', '稻城', '理塘', '丹巴'],
  四川: ['四川', '成都', '乐山', '峨眉', '九寨'],
  云南: ['云南', '滇', '昆明', '大理', '丽江', '香格里拉', '迪庆', '腾冲', '西双版纳'],
  西藏: ['西藏', '拉萨', '林芝', '阿里', '日喀则', '墨脱'],
  甘肃: ['甘肃', '河西走廊', '敦煌', '张掖', '嘉峪关', '甘南'],
  青海: ['青海', '西宁', '柴达木', '茶卡', '格尔木'],
  新疆: ['新疆', '伊犁', '喀什', '喀纳斯', '独库', '乌鲁木齐', '赛里木湖', '帕米尔'],
  贵州: ['贵州', '黔东南', '黔西南', '贵阳'],
  内蒙古: [
    '内蒙古',
    '内蒙',
    '赤峰',
    '克什克腾',
    '乌兰布统',
    '坝上',
    '呼伦贝尔',
    '锡林郭勒',
    '阿拉善',
    '额济纳',
    '鄂尔多斯',
    '阿尔山',
  ],
  河北: ['河北', '承德', '张家口', '秦皇岛', '北戴河', '塞罕坝'],
  北京: ['北京'],
  天津: ['天津'],
  山西: ['山西', '太原', '五台山', '平遥', '大同'],
  陕西: ['陕西', '西安', '华山', '延安'],
  宁夏: ['宁夏', '银川', '中卫'],
  山东: ['山东', '青岛', '泰山', '烟台', '威海'],
  河南: ['河南', '郑州', '洛阳', '开封'],
  湖北: ['湖北', '武汉', '神农架', '恩施'],
  湖南: ['湖南', '长沙', '张家界', '凤凰'],
  江苏: ['江苏', '南京', '苏州', '扬州'],
  浙江: ['浙江', '杭州', '千岛湖', '舟山'],
  安徽: ['安徽', '黄山', '宏村'],
  福建: ['福建', '厦门', '武夷山', '霞浦'],
  江西: ['江西', '婺源', '景德镇', '庐山'],
  广东: ['广东', '广州', '深圳', '珠海'],
  广西: ['广西', '桂林', '阳朔', '北海'],
  海南: ['海南', '三亚', '海口'],
  重庆: ['重庆'],
  东北: ['东北', '辽宁', '吉林', '黑龙江', '沈阳', '大连', '长白山', '哈尔滨', '漠河'],
}

/**
 * 依据区域名推断包围盒。
 *
 * 命中多个区域时取**并集**：「青海甘肃大环线」要同时覆盖两省，
 * 否则敦煌、张掖会被误判成越界。一个都认不出才退化为中国范围。
 */
export function bboxForRegion(region?: string | null): [number, number, number, number] {
  if (!region) return REGION_BBOX['中国']

  const matched = new Set<string>()
  for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
    if (aliases.some((alias) => region.includes(alias))) matched.add(key)
  }
  if (matched.size === 0) return REGION_BBOX['中国']

  const boxes = [...matched].map((key) => REGION_BBOX[key])
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ]
}
