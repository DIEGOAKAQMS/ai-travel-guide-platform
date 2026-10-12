import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { config } from '../config'

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.max,
})

pool.on('error', (error) => {
  console.error('[db] 空闲连接出错：', error.message)
})

/** 执行 SQL */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never)
  return result.rows
}

/** 单条查询 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows.length > 0 ? rows[0] : null
}

/** 事务包装 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** 连通性探测 */
export async function ping(): Promise<{ version: string; postgis: string | null }> {
  const versionRow = await queryOne<{ version: string }>('SELECT version() AS version')
  const postgisRow = await queryOne<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'postgis'",
  )
  return {
    version: versionRow?.version ?? 'unknown',
    postgis: postgisRow?.extversion ?? null,
  }
}
