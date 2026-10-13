/**
 * 把一份「已经写好」的攻略 JSON 导入数据库（不调用 LLM，只做落点解析 + 入库）。
 *
 * 走的是和 `generateGuide` 完全相同的落点 / 校验 / 写库路径（见 services/guide.ts 的
 * `importGuide` → `locateAndPersist`），所以导进来的攻略跨日衔接、点位坐标、
 * 离群复核都与在线生成的一致，导入后直接在地图工作台打开即可渲染。
 *
 * 用法（在 server 目录下执行）：
 *   npx tsx scripts/import-guide.ts ../docs/测试.txt                  # 正式导入
 *   npx tsx scripts/import-guide.ts ../docs/测试.txt --dry-run        # 只校验文件，不落点不写库
 *   npx tsx scripts/import-guide.ts ../docs/测试.txt --title "新标题"  # 覆盖标题
 *   npx tsx scripts/import-guide.ts ../docs/测试.txt --prompt "来源备注"  # 写进 guide.prompt
 *   npx tsx scripts/import-guide.ts ../docs/测试.txt --region 川西     # 覆盖区域（影响落点包围盒）
 *
 * ⚠️ 会真实消耗高德 / 天地图配额：可落点节点数 × 1~4 次请求，脚本按 4 并发限速执行。
 */
// 配置读取统一交给 src/config（分层加载 config.env > 根 .env > server/.env），
// 这里不要再 import 'dotenv/config'，否则 server/.env 会先进 process.env、抢在 config.env 前面生效。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bboxForRegion } from '../src/config'
import { importGuide, type GenerateEvent } from '../src/services/guide'
import type { LlmGuide, LlmNode } from '../src/types'

/** 去掉可能被包上的 markdown 代码块围栏 */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const matched = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return matched ? matched[1] : trimmed
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

/** 落点前的基本结构校验：字段名写错时早点报出来，别等落点跑完才失败 */
function validate(guide: LlmGuide): string[] {
  const problems: string[] = []
  if (!guide || typeof guide !== 'object') return ['JSON 根节点不是一个对象']
  if (!Array.isArray(guide.days) || guide.days.length === 0) problems.push('缺少非空的 days 数组')

  ;(guide.days ?? []).forEach((day, index) => {
    const where = `第 ${index + 1} 个 day（day_index=${day?.day_index}）`
    if (!Array.isArray(day?.timeline) || day.timeline.length === 0) {
      problems.push(`${where} 缺少非空的 timeline`)
      return
    }
    day.timeline.forEach((node: LlmNode, nodeIndex: number) => {
      if (!node?.name || typeof node.name !== 'string' || !node.name.trim()) {
        problems.push(`${where} 的第 ${nodeIndex + 1} 个节点缺少 name`)
      }
    })
  })
  return problems
}

function describe(event: GenerateEvent): string | null {
  if (event.type === 'stage') return `[阶段] ${event.message}`
  if (event.type === 'poi') {
    // 逐条打印会把几十行刷满屏，这里只在整十进度和异常状态时输出
    if (event.done % 10 === 0 || event.done === event.total || event.status !== 'ok') {
      return `[落点] ${event.done}/${event.total} ${event.name} → ${event.status}`
    }
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const file = args.find((arg) => !arg.startsWith('--'))
  if (!file) {
    console.log(
      '用法：tsx scripts/import-guide.ts <攻略 JSON 文件> [--dry-run] [--title 标题] [--prompt 备注] [--region 区域]',
    )
    process.exit(1)
  }

  const path = resolve(process.cwd(), file)
  const guide = JSON.parse(stripFences(readFileSync(path, 'utf8'))) as LlmGuide

  const region = readArg(args, '--region') ?? guide.region
  const nodeCount = (guide.days ?? []).reduce((sum, day) => sum + (day.timeline?.length ?? 0), 0)
  console.log(`文件：${path}`)
  console.log(`标题：${guide.title}`)
  console.log(`区域：${region ?? '(未指定，落点会按全国范围校验)'}`)
  console.log(`天数：${guide.days?.length ?? 0}，节点：${nodeCount}`)
  if (region) {
    const [minLng, minLat, maxLng, maxLat] = bboxForRegion(region)
    console.log(`落点包围盒：${minLng},${minLat} ~ ${maxLng},${maxLat}`)
  }

  const problems = validate(guide)
  if (problems.length > 0) {
    console.error('\n结构校验未通过：')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('结构校验：通过')

  if (args.includes('--dry-run')) {
    console.log('\n--dry-run：只校验文件，未落点、未写库。')
    return
  }

  console.log('')
  const result = await importGuide(
    guide,
    {
      title: readArg(args, '--title'),
      prompt: readArg(args, '--prompt') ?? `（导入）${path}`,
      region: readArg(args, '--region'),
    },
    (event) => {
      const line = describe(event)
      if (line) console.log(line)
    },
  )

  const { stats } = result
  console.log(`\n导入完成，guideId = ${result.guideId}`)
  console.log(
    `点位 ${stats.totalNodes} 个：ok ${stats.okCount} / suspect ${stats.suspectCount} / ` +
      `failed ${stats.failedCount} / skipped ${stats.skippedCount}`,
  )

  if (result.issues.length > 0) {
    console.log(`\n需要人工确认的节点（${result.issues.length} 个）：`)
    for (const issue of result.issues) {
      console.log(
        `  D${issue.day_index} ${issue.poi} → ${issue.status}` +
          `${issue.keyword ? `（检索词：${issue.keyword}）` : ''}：${issue.reason}`,
      )
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('导入失败：', error)
    process.exit(1)
  })
