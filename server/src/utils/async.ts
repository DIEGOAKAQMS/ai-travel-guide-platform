/** 并发受限的 map，避免瞬间打爆第三方接口配额 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

/** 简易重试 */
export async function retry<T>(
  fn: () => Promise<T>,
  times = 2,
  delayMs = 800,
): Promise<T> {
  let lastError: unknown
  for (let i = 0; i <= times; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < times) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)))
      }
    }
  }
  throw lastError
}

/**
 * 串行队列 + 最小请求间隔。
 *
 * 背景：高德对并发 QPS 有硬限制，实测并发 4 会直接触发
 * 10021 CUQPS_HAS_EXCEEDED_THE_LIMIT，导致后续请求连续失败。
 * 这里把所有第三方请求强制串行化并拉开间隔，稳定性优先。
 */
export function createSerialQueue(minIntervalMs: number) {
  let lastFinishedAt = 0
  let chain: Promise<unknown> = Promise.resolve()

  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastFinishedAt + minIntervalMs - Date.now()
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      try {
        return await task()
      } finally {
        lastFinishedAt = Date.now()
      }
    })

    // 队列本身不因单个任务失败而中断
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
