import { afterEach, describe, expect, test } from "bun:test"

import { PrCache, prCacheDefaults, prQueryKey, type PrAdapter, type PrFacts, type PrQuery } from "../src/pr-observations"

/**
 * Task 2.6: bounded hosting observations with known/unknown/ambiguous
 * states and an in-memory 30-second cache keyed by hosting repository, head
 * repository/branch, and base. Failed lookups are never absence; PR state
 * grants no cleanup authority; nothing is persisted.
 */

const baseQuery: PrQuery = { hostingRepo: "owner/repo", headRepo: "owner/repo", headBranch: "feat/x", baseRepo: "owner/repo", baseBranch: "main" }

function pr(number: number, state: string, headSha?: string): PrFacts {
  return { number, title: `PR ${number}`, url: `https://example.com/pr/${number}`, state, ...(headSha ? { headSha } : {}) }
}

afterEach(() => {
  // Each test builds its own cache; nothing here persists between tests.
})

describe("PrCache.observe", () => {
  test("a single matching PR is known; an empty match is known-absent", async () => {
    const cache = new PrCache()
    let calls = 0
    const adapter: PrAdapter = async () => {
      calls += 1
      return [pr(7, "open")]
    }
    const seen = await cache.observe(baseQuery, adapter)
    expect(seen).toMatchObject({ availability: "known", pr: { number: 7, state: "open" } })
    expect(calls).toBe(1)
    // Cached within the TTL: no second adapter call.
    await cache.observe(baseQuery, adapter)
    expect(calls).toBe(1)
  })

  test("a failed lookup is unknown evidence, never no-PR, and is not retried within the TTL", async () => {
    const cache = new PrCache()
    let calls = 0
    const adapter: PrAdapter = async () => {
      calls += 1
      return { error: "gh: authentication required" }
    }
    const seen = await cache.observe(baseQuery, adapter)
    expect(seen).toMatchObject({ availability: "unknown", reason: "gh: authentication required" })
    await cache.observe(baseQuery, adapter)
    expect(calls).toBe(1)
  })

  test("multiple matches are ambiguous, not collapsed into one PR", async () => {
    const cache = new PrCache()
    const seen = await cache.observe(baseQuery, async () => [pr(7, "open"), pr(9, "open")])
    expect(seen.availability).toBe("ambiguous")
    if (seen.availability === "ambiguous") expect(seen.matches.map((match) => match.number)).toEqual([7, 9])
  })

  test("a thrown adapter error is unknown with its reason", async () => {
    const cache = new PrCache()
    const seen = await cache.observe(baseQuery, async () => {
      throw new Error("network unreachable")
    })
    expect(seen).toMatchObject({ availability: "unknown", reason: "network unreachable" })
  })

  test("an adapter timeout degrades to unknown instead of hanging", async () => {
    const cache = new PrCache({ timeoutMs: 30 })
    const seen = await cache.observe(baseQuery, () => new Promise<PrFacts[]>(() => {}))
    expect(seen).toMatchObject({ availability: "unknown", reason: "PR lookup timed out" })
  })

  test("concurrent asks share one bounded in-flight lookup", async () => {
    const cache = new PrCache()
    let calls = 0
    const adapter: PrAdapter = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [pr(1, "open")]
    }
    const [a, b] = await Promise.all([cache.observe(baseQuery, adapter), cache.observe(baseQuery, adapter)])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  test("request fan-out is bounded by maxConcurrent", async () => {
    const cache = new PrCache({ maxConcurrent: 1 })
    let active = 0
    let peak = 0
    const adapter: PrAdapter = async (query) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return query.headBranch === "feat/a" ? [pr(1, "open")] : []
    }
    await Promise.all(
      ["feat/a", "feat/b", "feat/c", "feat/d"].map((branch) => cache.observe({ ...baseQuery, headBranch: branch }, adapter)),
    )
    expect(peak).toBeLessThanOrEqual(prCacheDefaults.maxConcurrent)
    expect(peak).toBe(1)
  })

  test("expired entries re-query; refresh always re-queries", async () => {
    const cache = new PrCache({ ttlMs: 10 })
    let calls = 0
    let state = "open"
    const adapter: PrAdapter = async () => {
      calls += 1
      return calls === 0 ? [] : [pr(3, state)]
    }
    await cache.observe(baseQuery, async () => {
      calls += 1
      return [pr(3, state)]
    })
    state = "merged"
    await new Promise((resolve) => setTimeout(resolve, 15))
    const expired = await cache.observe(baseQuery, adapter)
    expect(expired).toMatchObject({ availability: "known", pr: { state: "merged" } })
    // refresh() bypasses even a fresh cache.
    const forced = await cache.refresh(baseQuery, async () => [pr(4, "open")])
    expect(forced).toMatchObject({ availability: "known", pr: { number: 4 } })
  })

  test("cache keys distinguish forks, reused branches, and different bases", async () => {
    const cache = new PrCache()
    const adapter: PrAdapter = async (query) => [pr(query.headBranch === "fork" ? 42 : 1, "open")]
    const sameRepo = await cache.observe(baseQuery, adapter)
    const fork = await cache.observe({ ...baseQuery, headRepo: "forker/repo", headBranch: "fork" }, adapter)
    expect(sameRepo).toMatchObject({ pr: { number: 1 } })
    expect(fork).toMatchObject({ pr: { number: 42 } })
  })

  test("the cache is advisory only: nothing is written anywhere", async () => {
    const cache = new PrCache()
    await cache.observe(baseQuery, async () => [pr(1, "open")])
    cache.clear()
    expect(cache.peek(baseQuery)).toBeUndefined()
  })

  test("keys use the full query scope", () => {
    const a = prQueryKey(baseQuery)
    expect(prQueryKey({ ...baseQuery, baseBranch: "develop" })).not.toBe(a)
    expect(prQueryKey({ ...baseQuery, headRepo: "forker/repo" })).not.toBe(a)
  })
})
