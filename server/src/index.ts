import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { config } from './config'
import { migrate } from './db/migrate'
import { ping, pool } from './db/pool'
import { guideRouter } from './routes/guide'

const app = express()

app.use(cors())
app.use(express.json({ limit: '4mb' }))

// 简易请求日志
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`)
  next()
})

app.get('/api/health', async (_req, res) => {
  try {
    const info = await ping()
    res.json({
      ok: true,
      data: {
        env: config.env,
        db: { connected: true, version: info.version.split(',')[0], postgis: info.postgis },
        llm: { model: config.deepseek.model, maxTokens: config.deepseek.maxTokens },
        amap: { configured: Boolean(config.amap.key) },
        tianditu: { configured: Boolean(config.tianditu.token) },
      },
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message })
  }
})

app.use('/api/guide', guideRouter)

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' })
})

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', error)
  res.status(500).json({ ok: false, error: error.message || '服务器内部错误' })
})

async function main(): Promise<void> {
  // 启动时自动建表，保证开箱可用
  await migrate()
  const info = await ping()

  app.listen(config.port, () => {
    console.log('==============================================')
    console.log(`  旅游攻略后端服务已启动`)
    console.log(`  http://127.0.0.1:${config.port}`)
    console.log(`  数据库：${config.db.database}  PostGIS ${info.postgis ?? '未安装'}`)
    console.log(`  模型：${config.deepseek.model}  (max_tokens=${config.deepseek.maxTokens})`)
    console.log('==============================================')
  })
}

main().catch(async (error) => {
  console.error('启动失败：', error)
  await pool.end().catch(() => undefined)
  process.exit(1)
})
