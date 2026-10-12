import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pool, ping } from './pool'

/** 幂等执行 sql/schema.sql（脚本内全部使用 IF NOT EXISTS / CREATE OR REPLACE） */
export async function migrate(): Promise<void> {
  const schemaPath = path.join(__dirname, '..', '..', 'sql', 'schema.sql')
  const sql = await readFile(schemaPath, 'utf8')
  await pool.query(sql)
}

async function main(): Promise<void> {
  const info = await ping()
  console.log('[migrate] 已连接：', info.version.split(',')[0])
  console.log('[migrate] PostGIS：', info.postgis ?? '未安装')
  await migrate()
  console.log('[migrate] schema 执行完成')
  await pool.end()
}

// 仅作为脚本直接运行时执行
if (require.main === module) {
  main().catch(async (error) => {
    console.error('[migrate] 失败：', error)
    await pool.end().catch(() => undefined)
    process.exit(1)
  })
}
