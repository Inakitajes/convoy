import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { bootOpencodeServerFrom } from "./opencode"
import { captureIdentity, defaultIdentityProbe, type IdentityProbe, type ProcessIdentity } from "./process-identity"
import { readJsonFile, removePath, withExclusiveLock, writeJsonFile, type StoreRead } from "./repo-store"
import { convoySecretsDir } from "./workspace"

/**
 * The discovery record's schema version; bumped only for a wire-format change.
 * 2: an OpenCode V2 server. A schema-1 record names a pre-V2 server that the
 * V2 client cannot drive.
 */
const schemaVersion = 2
const preV2SchemaVersion = 1

/**
 * The authoring conversation service (capability work-conversations, design
 * D5, task 4.3): discovery and lifetime of the OpenCode server that backs
 * authoring conversations, independent of run servers and of any TUI
 * attachment. One live server per repository is reused by every authoring
 * flow; its discovery record is transient state — never a durable feature
 * record — and is always liveness-verified before reuse (never trusted from
 * a saved PID or URL alone).
 *
 * Shutdown boundaries, verified by tests:
 * - a run's server or dashboard closing never stops this service (nothing
 *   run-owned is ever shared with it), and
 * - a client view detaching or closing never stops it either — only an
 *   explicit stop with quiescence evidence does, and a stop that cannot rule
 *   out active execution keeps the service alive instead.
 *
 * Layout: <common-dir>/convoy/authoring-server.json (transient discovery)
 *         <convoy-home>/private/authoring/<repo>.json (its password, owner-only)
 */

/** How long the liveness probe waits for the server to answer. */
const probeTimeoutMs = 1_500

/**
 * The transient discovery record for the repository's authoring server.
 * `pid` is the spawned `opencode serve` child; `bootCheckout` is the checkout
 * the server was booted from (any checkout of the same repository resolves
 * the same sessions — OpenCode scopes projects by repository).
 */
export type ConversationServiceRecord = {
  schemaVersion: number
  url: string
  pid: number
  bootCheckout: string
  startedAt: number
  /**
   * The V2 per-boot HTTP Basic password for the recorded server (design D2).
   * Never written into the record, which lives in the checkout's Git dir that
   * agents read: it is kept in `conversationServiceSecretPath`. A record from
   * an earlier build may still carry it, and is honored until replaced.
   */
  password?: string
  /**
   * Kernel birth identity of the recorded child for servers booted by this
   * build (design D6). Optional and additive: legacy records simply omit it,
   * and an explicit stop only re-verifies it when present so a recycled PID
   * can never be killed as though it were the recorded server. The probe is
   * not atomic, so this strengthens — never overstates — the guarded stop.
   */
  childBirth?: string
}

export function validateConversationServiceRecord(value: unknown): ConversationServiceRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== schemaVersion) return undefined
  // The authoring server always binds to loopback (bootOpencodeServerFrom uses
  // 127.0.0.1), so a valid discovery URL must be a loopback http URL. A record
  // pointing elsewhere is not evidence of this repository's server and would
  // make the liveness probe / client connect to an arbitrary host — refuse it.
  if (typeof record.url !== "string" || !isLoopbackHttpUrl(record.url)) return undefined
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined
  if (typeof record.bootCheckout !== "string" || record.bootCheckout === "") return undefined
  if (typeof record.startedAt !== "number") return undefined
  if (record.childBirth !== undefined && typeof record.childBirth !== "string") return undefined
  return {
    schemaVersion: schemaVersion,
    url: record.url,
    pid: record.pid,
    bootCheckout: record.bootCheckout,
    startedAt: record.startedAt,
    ...(typeof record.password === "string" && record.password !== "" ? { password: record.password } : {}),
    ...(typeof record.childBirth === "string" && record.childBirth !== "" ? { childBirth: record.childBirth } : {}),
  }
}

/**
 * Whether `url` is an http URL on a loopback interface (the only place the
 * authoring server binds). Parsed with `new URL` and compared by exact
 * hostname, so a lookalike host — `http://127.0.0.1.evil.com`,
 * `http://localhost.attacker.com`, or userinfo like `http://127.0.0.1@evil.com`
 * — is rejected rather than passing a bare prefix match.
 */
function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:") return false
  // URL.hostname preserves IPv6 brackets ([::1]); strip them for the comparison.
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  return host === "127.0.0.1" || host === "localhost" || host === "::1"
}

function discoveryPath(commonDir: string): string {
  return join(commonDir, "convoy", "authoring-server.json")
}

/** Where the repository's authoring password lives: outside every checkout, keyed by its common dir. */
export function conversationServiceSecretPath(commonDir: string): string {
  const key = createHash("sha256").update(commonDir).digest("hex").slice(0, 32)
  return join(convoySecretsDir(), "authoring", `${key}.json`)
}

async function readServiceSecret(commonDir: string): Promise<{ url: string; password: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(conversationServiceSecretPath(commonDir), "utf8")) as Record<string, unknown>
    if (typeof parsed.url !== "string" || typeof parsed.password !== "string" || parsed.password === "") return undefined
    return { url: parsed.url, password: parsed.password }
  } catch {
    return undefined
  }
}

async function removeServiceRecord(commonDir: string): Promise<void> {
  await removePath(discoveryPath(commonDir))
  await removePath(conversationServiceSecretPath(commonDir))
}

/**
 * Reads the transient discovery record; a missing record is simply "none".
 * The password is joined from its private file, and only when that file names
 * the same server, so a stale secret never authenticates a different one.
 */
export async function readConversationServiceDiscovery(commonDir: string): Promise<StoreRead<ConversationServiceRecord>> {
  const read = await readJsonFile(discoveryPath(commonDir), validateConversationServiceRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion !== schemaVersion,
  })
  if (read.status !== "found" || read.value.password) return read
  const secret = await readServiceSecret(commonDir)
  return secret?.url === read.value.url ? { ...read, value: { ...read.value, password: secret.password } } : read
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ESRCH") return false
    // EPERM: the process exists but belongs to someone else — alive.
    return code === "EPERM"
  }
}

/** Whether the recorded URL answers at all (any HTTP response counts; the probe is a liveness check, not a shape check). */
export async function urlReachable(url: string, timeoutMs = probeTimeoutMs): Promise<boolean> {
  try {
    await fetch(url.replace(/\/$/, "") + "/session", { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/**
 * The service's liveness assessment. A dead PID is proof the server is gone
 * (stale); an alive PID whose URL answers is live; an alive PID whose URL
 * does not answer is uncertain — the process may be starting, wedged, or a
 * recycled PID. Only a stale service is replaced; an uncertain one is
 * reported for reconciliation, never killed or booted over.
 */
export async function probeConversationService(record: ConversationServiceRecord): Promise<"live" | "stale" | "uncertain"> {
  if (!pidAlive(record.pid)) return "stale"
  return (await urlReachable(record.url)) ? "live" : "uncertain"
}

/** The outcome of ensuring the repository's authoring service. */
export type ConversationServiceOutcome =
  | { status: "live"; url: string; password?: string; record: ConversationServiceRecord; reused: boolean }
  | { status: "uncertain"; reason: string; record?: ConversationServiceRecord }
  | { status: "unavailable"; reason: string }

/**
 * Ensures the repository's authoring service is live and returns its URL.
 * A live discovered service is reused; a stale one (dead PID) is replaced by
 * a fresh boot; an uncertain one (alive PID, unanswerable URL) or an
 * unreadable record is reported instead of being booted over — the caller
 * falls back to bounded per-call boots, which never disturb the record.
 * Boot failures return `unavailable` with the cause; nothing is persisted.
 */
export async function ensureConversationService(input: {
  commonDir: string
  /** The checkout the server is rooted at when a fresh boot is needed. */
  checkout: string
  bootTimeoutMs?: number
  /** Injected boot (tests); defaults to the detached OpenCode server boot. */
  boot?: (checkout: string, timeoutMs?: number) => Promise<{ url: string; password?: string; close(): void | Promise<unknown>; pid: number; identity?: ProcessIdentity }>
  /** Injected probe (tests); defaults to the PID + URL liveness probe. */
  probe?: (record: ConversationServiceRecord) => Promise<"live" | "stale" | "uncertain">
}): Promise<ConversationServiceOutcome> {
  const boot =
    input.boot ??
    ((checkout: string, timeoutMs?: number) =>
      // An independently persistent authoring service: explicitly excluded
      // from run/helper orphan reconciliation (design D1/D6).
      bootOpencodeServerFrom(checkout, timeoutMs ?? 30_000, { lifetime: "authoring-service" }))
  const probe = input.probe ?? probeConversationService
  let outcome: ConversationServiceOutcome = { status: "uncertain", reason: "the authoring service lock was lost" }
  await withExclusiveLock(join(input.commonDir, "convoy", "authoring-service"), async () => {
    const read = await readConversationServiceDiscovery(input.commonDir)
    if (read.status === "found") {
      const liveness = await probe(read.value)
      if (liveness === "live") {
        outcome = { status: "live", url: read.value.url, ...(read.value.password ? { password: read.value.password } : {}), record: read.value, reused: true }
        return
      }
      if (liveness === "uncertain") {
        outcome = {
          status: "uncertain",
          reason: `an authoring server for this repository is in an unverified state (pid ${read.value.pid} alive, ${read.value.url} unreachable) — stop it explicitly or wait for it to answer before conversation work`,
          record: read.value,
        }
        return
      }
      // Stale: the recorded server is provably gone; replace the record.
      await removeServiceRecord(input.commonDir)
    } else if (read.status !== "missing") {
      // Corrupt/unsupported/unreadable discovery is not evidence of a live
      // server, but it is also not clean state: report instead of overwriting.
      outcome = {
        status: "uncertain",
        reason:
          read.status === "unsupported" && read.schemaVersion === preV2SchemaVersion
            ? `an authoring server from before the OpenCode V2 migration may still be running — stop the pid recorded in ${discoveryPath(input.commonDir)}, then delete that record, before conversation work`
            : `the authoring service discovery record is ${read.status === "unreadable" ? `unreadable: ${read.reason}` : read.status} — inspect ${discoveryPath(input.commonDir)} before conversation work`,
      }
      return
    }
    let booted: { url: string; password?: string; close(): void | Promise<unknown>; pid: number; identity?: ProcessIdentity }
    try {
      booted = await boot(input.checkout, input.bootTimeoutMs)
    } catch (error) {
      outcome = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
      return
    }
    const record: ConversationServiceRecord = {
      schemaVersion: schemaVersion,
      url: booted.url,
      pid: booted.pid,
      bootCheckout: input.checkout,
      startedAt: Date.now(),
      ...(booted.password ? { password: booted.password } : {}),
      // Retain the child's kernel birth identity for newly booted services so
      // the guarded stop can refuse a recycled PID (design D6).
      ...(booted.identity?.birth ? { childBirth: booted.identity.birth } : {}),
    }
    try {
      // The password goes first, to a private file outside the checkout: the
      // record a reader discovers must never be usable without it.
      if (booted.password) {
        await mkdir(dirname(conversationServiceSecretPath(input.commonDir)), { recursive: true, mode: 0o700 })
        await writeJsonFile(conversationServiceSecretPath(input.commonDir), { url: booted.url, password: booted.password }, { mode: 0o600 })
      }
      const { password: _password, ...publicRecord } = record
      await writeJsonFile(discoveryPath(input.commonDir), publicRecord, { mode: 0o600 })
    } catch (error) {
      await removePath(conversationServiceSecretPath(input.commonDir))
      // An unpublished child has no discovery record to control its lifetime:
      // close it rather than leak an unreachable server (design D6).
      await Promise.resolve(booted.close()).catch(() => {})
      outcome = { status: "unavailable", reason: `the authoring service discovery record could not be written: ${error instanceof Error ? error.message : String(error)}` }
      return
    }
    outcome = { status: "live", url: booted.url, ...(booted.password ? { password: booted.password } : {}), record, reused: false }
  })
  return outcome
}

/**
 * Explicitly stops the repository's authoring service. The caller must supply
 * quiescence evidence for the work using it: anything else (busy, unknown, or
 * absent evidence) keeps the service alive — active execution must never be
 * silently terminated by a shutdown request (capability work-conversations).
 * A stopped service's discovery record is removed and the recorded child is
 * terminated only after its identity is re-verified (PID alive and URL
 * answering) so a recycled PID can never be killed.
 */
export async function stopConversationService(input: {
  commonDir: string
  /** Quiescence evidence for the service's active work. */
  activity: "idle" | "busy" | "unknown"
  /** Injected probe (tests); defaults to the PID + URL liveness probe. */
  probe?: (record: ConversationServiceRecord) => Promise<"live" | "stale" | "uncertain">
  /** Injected identity probe (tests); defaults to the platform kernel probe. */
  identityProbe?: IdentityProbe
  /** Injected kill (tests); defaults to SIGTERM on the recorded PID. */
  kill?: (record: ConversationServiceRecord) => Promise<void> | void
}): Promise<{ status: "stopped" } | { status: "kept"; reason: string } | { status: "missing" }> {
  if (input.activity !== "idle") {
    return {
      status: "kept",
      reason:
        input.activity === "busy"
          ? "the authoring service still has active execution — stop it explicitly first"
          : "the authoring service's execution state is unknown — it is kept alive rather than silently stopped",
    }
  }
  const read = await readConversationServiceDiscovery(input.commonDir)
  if (read.status === "missing") return { status: "missing" }
  if (read.status !== "found") return { status: "kept", reason: `the authoring service discovery record is ${read.status === "unreadable" ? `unreadable: ${read.reason}` : read.status}` }
  const record = read.value
  const probe = input.probe ?? probeConversationService
  const liveness = await probe(record)
  if (liveness === "uncertain") {
    // An alive PID behind an unanswerable URL is neither provably serving nor
    // provably gone: keep both the process and its discovery record for
    // reconciliation instead of orphaning a running server.
    return { status: "kept", reason: `the authoring server (pid ${record.pid}, ${record.url}) is in an unverified state — it is kept until it answers or its process is gone` }
  }
  if (liveness === "live") {
    // Newly booted services record their child's kernel birth identity. An
    // explicit stop re-verifies it where present so a recycled PID behind a
    // stale URL answer is never killed as though it were the recorded server
    // (design D6). Legacy records without identity keep the PID+URL intent.
    if (record.childBirth) {
      const observed = await captureIdentity(record.pid, input.identityProbe ?? defaultIdentityProbe())
      if (!observed || observed.birth !== record.childBirth) {
        return {
          status: "kept",
          reason: `the authoring server pid ${record.pid} no longer matches its recorded child identity — it is kept rather than killed`,
        }
      }
    }
    const kill = input.kill ?? (async (target: ConversationServiceRecord) => {
      process.kill(target.pid, "SIGTERM")
    })
    await kill(record)
  }
  // Live → killed; stale → already gone: the record describes a service that
  // no longer exists, so it is removed.
  await removeServiceRecord(input.commonDir)
  return { status: "stopped" }
}
