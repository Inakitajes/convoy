/**
 * Bounded hosting (pull request) observations (change
 * `worktree-control-center`, task 2.6, design D2): small typed facts about
 * PRs, kept in memory with a short TTL and never persisted. Availability is
 * explicit — a missing tool, failed authentication, network error, or
 * ambiguous match is *unknown/ambiguous evidence*, never "no PR" and never
 * "merged". PR state is a fact about that PR: a merged PR for an older head
 * or a reused branch name never makes current work completed, and no
 * observation here grants cleanup or deletion authority.
 */

export type PrFacts = {
  number: number
  title: string
  url: string
  /** The PR's own state as the hosting service reports it. */
  state: "open" | "merged" | "closed" | string
  /** The head commit the service associated with this PR, when reported. */
  headSha?: string
}

export type PrObservation =
  | { availability: "known"; pr?: PrFacts; observedAt: number }
  | { availability: "unknown"; reason: string; observedAt: number }
  | { availability: "ambiguous"; reason: string; matches: PrFacts[]; observedAt: number }

/** The exact scope a PR question is asked about; keys and queries use it verbatim. */
export type PrQuery = {
  /** Repository the PR lives on (e.g. `owner/repo`). */
  hostingRepo: string
  /** Head repository/branch (forks have a different head repo). */
  headRepo: string
  headBranch: string
  /** Base repository/branch the PR targets. */
  baseRepo: string
  baseBranch: string
}

export function prQueryKey(query: PrQuery): string {
  return [query.hostingRepo, query.headRepo, query.headBranch, query.baseRepo, query.baseBranch].join("\u0000")
}

/** The hosting lookup itself; implementations wrap `gh` or a mock. */
export type PrAdapter = (query: PrQuery) => Promise<PrFacts[] | { error: string }>

export type PrCacheOptions = {
  /** How long a known observation stays fresh (default 30s). */
  ttlMs?: number
  /** Maximum adapter calls in flight at once (default 2). */
  maxConcurrent?: number
  /** Adapter timeout (default 5s). */
  timeoutMs?: number
}

type CacheEntry = { observation: PrObservation; cachedAt: number }

/** Maximum concurrent adapter calls; bounded requests, never unbounded fan-out. */
const defaultMaxConcurrent = 2
const defaultTtlMs = 30_000
const defaultTimeoutMs = 5_000

/**
 * In-memory PR observation cache keyed by hosting repository, head
 * repository/branch, and base. Advisory only: discarded on session end,
 * never written to disk, never treated as truth — mutations revalidate
 * through a fresh lookup (`refresh`). Fetching is a visible operation the
 * caller triggers, never a list-render side effect.
 */
export class PrCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<PrObservation>>()
  private readonly ttlMs: number
  private readonly maxConcurrent: number
  private readonly timeoutMs: number
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: PrCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? defaultTtlMs
    this.maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  }

  /** The current cached observation for a query, without querying. */
  peek(query: PrQuery): PrObservation | undefined {
    return this.entries.get(prQueryKey(query))?.observation
  }

  /**
   * The observation for a query: fresh from cache when young enough,
   * otherwise one bounded adapter call shared by concurrent askers.
   * Errors, timeouts, and missing tooling degrade to unknown — the caller
   * decides what unknown means for the action at hand.
   */
  async observe(query: PrQuery, adapter: PrAdapter): Promise<PrObservation> {
    const key = prQueryKey(query)
    const cached = this.entries.get(key)
    if (cached && Date.now() - cached.cachedAt <= this.ttlMs) {
      // Any observation is cached for the TTL — including unknown — so a
      // failing provider is not hammered on every render. refresh() forces
      // a re-query when the operator wants fresh evidence.
      return cached.observation
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const lookup = this.runBounded(() => this.callAdapter(query, adapter)).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, lookup)
    return lookup
  }

  /** Forces a fresh adapter call for the query, replacing any cached value. */
  async refresh(query: PrQuery, adapter: PrAdapter): Promise<PrObservation> {
    const key = prQueryKey(query)
    const lookup = this.runBounded(() => this.callAdapter(query, adapter)).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, lookup)
    return lookup
  }

  /** Drops everything advisory. */
  clear(): void {
    this.entries.clear()
  }

  private async runBounded<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((release) => this.waiting.push(release))
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }

  private async callAdapter(query: PrQuery, adapter: PrAdapter): Promise<PrObservation> {
    const observedAt = Date.now()
    let outcome: PrFacts[] | { error: string }
    try {
      outcome = await Promise.race([
        adapter(query),
        new Promise<{ error: string }>((_, reject) => setTimeout(() => reject(new Error("PR lookup timed out")), this.timeoutMs).unref?.()),
      ])
    } catch (error) {
      const observation: PrObservation = {
        availability: "unknown",
        reason: error instanceof Error ? error.message : String(error),
        observedAt,
      }
      this.entries.set(prQueryKey(query), { observation, cachedAt: observedAt })
      return observation
    }
    let observation: PrObservation
    if ("error" in outcome) {
      observation = { availability: "unknown", reason: outcome.error, observedAt }
    } else if (outcome.length === 0) {
      observation = { availability: "known", pr: undefined, observedAt }
    } else if (outcome.length === 1) {
      observation = { availability: "known", pr: outcome[0]!, observedAt }
    } else {
      observation = { availability: "ambiguous", reason: "multiple matching pull requests", matches: outcome, observedAt }
    }
    this.entries.set(prQueryKey(query), { observation, cachedAt: observedAt })
    return observation
  }
}

/** The number of concurrent adapter calls currently allowed by default bounds (for tests). */
export const prCacheDefaults = { ttlMs: defaultTtlMs, maxConcurrent: defaultMaxConcurrent, timeoutMs: defaultTimeoutMs }
