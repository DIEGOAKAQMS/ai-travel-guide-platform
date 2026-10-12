import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`缺少必需的环境变量 ${name}，请检查 server/.env`)
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : fallback
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
     * deepseek-flash 为推理模型，reasoning_content 会占用输出预算，
     * 预算不足时 content 会被截断成空串，因此这里给足。
     */
    maxTokens: Number(optional('DEEPSEEK_MAX_TOKENS', '16384')),
    timeoutMs: Number(optional('DEEPSEEK_TIMEOUT_MS', '300000')),
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
