import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { log } from "./log"
import { readKeychainSecret } from "./secrets"

/**
 * Subscription/credit meters for the run TUI header: the ChatGPT (Codex)
 * subscription's rate-limit windows and the OpenRouter credit balance.
 * Everything here is account-level data polled in the background — the run
 * itself never depends on it, so every failure path degrades to "no data".
 */

export type GptLimits = {
  /** primary_window.used_percent, 0-100 (the 5h session). */
  sessionPct: number
  /** Epoch ms when the 5h window resets. */
  sessionResetsAt?: number
  /** secondary_window.used_percent (the weekly limit). */
  weeklyPct?: number
}

export type OpenRouterLimits =
  | { kind: "remaining"; amount: number } // $ left (exact balance or key limit_remaining)
  | { kind: "monthly"; amount: number } // fallback: $ spent this month on a limitless key

export type LimitsSnapshot = {
  gpt?: GptLimits
  /** Auth problem worth showing instead of the meter, e.g. "codex login". */
  gptHint?: string
  openrouter?: OpenRouterLimits
  fetchedAt: number
}

const usageUrl = "https://chatgpt.com/backend-api/wham/usage"
const tokenUrl = "https://auth.openai.com/oauth/token"
// Public OAuth client id of the official Codex CLI.
const codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann"
const refreshMarginMs = 5 * 60_000
const creditsUrl = "https://openrouter.ai/api/v1/credits"
const keyUrl = "https://openrouter.ai/api/v1/key"
const fetchTimeoutMs = 10_000

export const limitsPollMs = 180_000

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested with fixtures).

type RateWindow = { used_percent?: unknown; reset_at?: unknown }

function windowPct(window: RateWindow | undefined): number | undefined {
  return window && typeof window.used_percent === "number" ? window.used_percent : undefined
}

function windowResetMs(window: RateWindow | undefined): number | undefined {
  if (!window || typeof window.reset_at !== "number" || window.reset_at <= 0) return undefined
  // The endpoint has served both epoch seconds and milliseconds.
  return window.reset_at > 1e12 ? window.reset_at : window.reset_at * 1000
}

/** `wham/usage` payload → the two windows the header shows. */
export function parseCodexUsage(data: unknown): GptLimits | undefined {
  const rateLimit = (data as { rate_limit?: { primary_window?: RateWindow; secondary_window?: RateWindow } } | undefined)?.rate_limit
  const sessionPct = windowPct(rateLimit?.primary_window)
  if (sessionPct === undefined) return undefined
  return {
    sessionPct,
    sessionResetsAt: windowResetMs(rateLimit?.primary_window),
    weeklyPct: windowPct(rateLimit?.secondary_window),
  }
}

/** Expiry of a JWT access token in epoch ms, or null when undecodable. */
export function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** `/api/v1/credits` payload (management keys only) → exact remaining balance. */
export function parseOpenRouterCredits(data: unknown): OpenRouterLimits | undefined {
  const body = (data as { data?: { total_credits?: unknown; total_usage?: unknown } } | undefined)?.data
  if (typeof body?.total_credits !== "number" || typeof body.total_usage !== "number") return undefined
  return { kind: "remaining", amount: body.total_credits - body.total_usage }
}

/** `/api/v1/key` payload (any key) → key limit remaining, else this month's spend. */
export function parseOpenRouterKey(data: unknown): OpenRouterLimits | undefined {
  const body = (data as { data?: { limit_remaining?: unknown; usage_monthly?: unknown; usage?: unknown } } | undefined)?.data
  if (!body) return undefined
  if (typeof body.limit_remaining === "number") return { kind: "remaining", amount: body.limit_remaining }
  const monthly = typeof body.usage_monthly === "number" ? body.usage_monthly : body.usage
  return typeof monthly === "number" ? { kind: "monthly", amount: monthly } : undefined
}

/** Key from the environment, else the one OpenCode already stores. */
export function openRouterKeyFrom(env: Record<string, string | undefined>, opencodeAuth: unknown): string | undefined {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY
  const entry = (opencodeAuth as { openrouter?: { type?: unknown; key?: unknown } } | undefined)?.openrouter
  if (entry?.type === "api" && typeof entry.key === "string" && entry.key.length > 0) return entry.key
  return undefined
}

// ---------------------------------------------------------------------------
// IO: token handling and fetchers. Never throw — every path folds into a
// FetchResult so a network hiccup can't take the TUI down.

type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "auth"; hint?: string }
  | { ok: false; kind: "transient" }

function codexAuthPath() {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")
}

function opencodeAuthPath() {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")
}

type CodexAuth = {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string }
  last_refresh?: string
}

/**
 * Refresh the Codex access token when it expires within the margin,
 * persisting the rotation like the official CLI does. Runway and the Codex
 * CLI poll the same file, so before writing we re-read it and skip the
 * persist if someone else already rotated past us.
 */
async function refreshCodexIfNeeded(auth: CodexAuth, authPath: string): Promise<{ token: string; authError?: string }> {
  const token = auth.tokens!.access_token!
  const refreshToken = auth.tokens?.refresh_token
  const expMs = jwtExpMs(token)
  if (!refreshToken || expMs === null || expMs > Date.now() + refreshMarginMs) return { token }

  let res: Response
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: codexClientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
  } catch {
    return { token } // No network: try the current token and let the usage fetch fail.
  }
  if (res.status === 400 || res.status === 401) return { token, authError: "codex login" }
  if (!res.ok) return { token }

  try {
    const fresh = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
    if (!fresh.access_token) return { token }
    const current = JSON.parse(await readFile(authPath, "utf8")) as CodexAuth
    if (current.tokens?.refresh_token === refreshToken) {
      current.tokens.access_token = fresh.access_token
      if (fresh.refresh_token) current.tokens.refresh_token = fresh.refresh_token
      if (fresh.id_token) current.tokens.id_token = fresh.id_token
      current.last_refresh = new Date().toISOString()
      await writeFile(authPath, JSON.stringify(current, null, 2))
    }
    return { token: fresh.access_token }
  } catch {
    return { token }
  }
}

async function fetchGptUsage(): Promise<FetchResult<GptLimits>> {
  const authPath = codexAuthPath()
  let auth: CodexAuth
  try {
    // Re-read every tick: runway/the Codex CLI rotate the same file.
    auth = JSON.parse(await readFile(authPath, "utf8")) as CodexAuth
  } catch {
    return { ok: false, kind: "auth", hint: "codex login" }
  }
  if (!auth?.tokens?.access_token) return { ok: false, kind: "auth", hint: "codex login" }

  const { token, authError } = await refreshCodexIfNeeded(auth, authPath)
  if (authError) return { ok: false, kind: "auth", hint: authError }

  let res: Response
  try {
    res = await fetch(usageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(auth.tokens.account_id ? { "chatgpt-account-id": auth.tokens.account_id } : {}),
      },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
  } catch {
    return { ok: false, kind: "transient" }
  }
  if (res.status === 401) return { ok: false, kind: "auth", hint: "codex login" }
  if (!res.ok) return { ok: false, kind: "transient" }

  try {
    const limits = parseCodexUsage(await res.json())
    return limits ? { ok: true, value: limits } : { ok: false, kind: "transient" }
  } catch {
    return { ok: false, kind: "transient" }
  }
}

async function resolveOpenRouterKey(): Promise<string | undefined> {
  // Keychain (convoy auth openrouter) wins: it's the management key that
  // unlocks the exact /credits balance. Re-resolved every tick so a fresh
  // `convoy auth` is picked up without restarting the TUI.
  const fromKeychain = await readKeychainSecret("openrouter")
  if (fromKeychain) return fromKeychain
  let opencodeAuth: unknown
  try {
    opencodeAuth = JSON.parse(await readFile(opencodeAuthPath(), "utf8"))
  } catch {
    opencodeAuth = undefined
  }
  return openRouterKeyFrom(process.env, opencodeAuth)
}

/** Which key sources exist, for `convoy auth status`. Never exposes the keys. */
export async function openRouterKeySources(): Promise<{ keychain: boolean; env: boolean; opencode: boolean }> {
  const keychain = (await readKeychainSecret("openrouter")) !== undefined
  let opencodeAuth: unknown
  try {
    opencodeAuth = JSON.parse(await readFile(opencodeAuthPath(), "utf8"))
  } catch {
    opencodeAuth = undefined
  }
  return {
    keychain,
    env: Boolean(process.env.OPENROUTER_API_KEY),
    opencode: openRouterKeyFrom({}, opencodeAuth) !== undefined,
  }
}

async function fetchOpenRouter(): Promise<FetchResult<OpenRouterLimits>> {
  const key = await resolveOpenRouterKey()
  if (!key) return { ok: false, kind: "auth" }
  const headers = { Authorization: `Bearer ${key}` }

  let res: Response
  try {
    res = await fetch(creditsUrl, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) })
  } catch {
    return { ok: false, kind: "transient" }
  }
  if (res.ok) {
    try {
      const limits = parseOpenRouterCredits(await res.json())
      if (limits) return { ok: true, value: limits }
    } catch {}
    return { ok: false, kind: "transient" }
  }
  if (res.status === 401) return { ok: false, kind: "auth" }
  if (res.status !== 403) return { ok: false, kind: "transient" }

  // 403: a regular inference key can't read /credits; /key works for any key.
  try {
    res = await fetch(keyUrl, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) })
  } catch {
    return { ok: false, kind: "transient" }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth" }
  if (!res.ok) return { ok: false, kind: "transient" }
  try {
    const limits = parseOpenRouterKey(await res.json())
    return limits ? { ok: true, value: limits } : { ok: false, kind: "transient" }
  } catch {
    return { ok: false, kind: "transient" }
  }
}

// ---------------------------------------------------------------------------
// Poller.

// Last snapshot fetched by any poller in this process: convoy's TUIs open in
// quick succession (launcher → run dashboard, runs browser → reopened run),
// and each one starts its own poller — the cache gives the next header its
// data instantly and skips re-hitting the endpoints seconds apart.
let lastSnapshot: LimitsSnapshot | undefined
const freshEnoughMs = 30_000

/**
 * Background poll of both providers. `ok` replaces the segment, `auth` clears
 * it (surfacing a hint for GPT), `transient` keeps the last good data so a
 * blip doesn't blank the header. The returned stop() also gates in-flight
 * ticks so nothing resurrects state after the TUI is torn down.
 */
export function startLimitsPoller(onUpdate: (snapshot: LimitsSnapshot) => void, intervalMs = limitsPollMs): () => void {
  let stopped = false
  let last: LimitsSnapshot = lastSnapshot ?? { fetchedAt: 0 }
  if (lastSnapshot) onUpdate(lastSnapshot)

  const tick = async () => {
    try {
      const [gpt, openrouter] = await Promise.all([fetchGptUsage(), fetchOpenRouter()])
      if (stopped) return
      last = {
        fetchedAt: Date.now(),
        gpt: gpt.ok ? gpt.value : gpt.kind === "transient" ? last.gpt : undefined,
        gptHint: gpt.ok ? undefined : gpt.kind === "auth" ? (gpt.hint ?? "codex login") : last.gptHint,
        openrouter: openrouter.ok ? openrouter.value : openrouter.kind === "transient" ? last.openrouter : undefined,
      }
      lastSnapshot = last
      onUpdate(last)
    } catch (error) {
      log.warn(`limits poll failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (Date.now() - last.fetchedAt >= freshEnoughMs) void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
