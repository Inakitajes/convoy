/**
 * Generic bounded-concurrency primitives.
 *
 * The control board's per-checkout observation and the board source's
 * fingerprint pass both need to fan out over a possibly large checkout list
 * without opening an unbounded number of subprocesses at once. They share one
 * ordered map here instead of each carrying a private copy (change
 * `live-board-cache-and-refresh`).
 */

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * preserving input order. The worker count is clamped to the item count so an
 * empty list spawns no work; results are non-null for every index.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
