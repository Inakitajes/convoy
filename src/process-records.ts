/**
 * Durable, private lifecycle records for Convoy-managed OpenCode servers
 * (change `fix-opencode-server-lifecycle`, design D5).
 *
 * These records are transient execution evidence, not worktree ownership and
 * not a feature registry. They live under `~/.convoy/processes/`, outside
 * disposable run workspaces and outside `pending/`, so ordinary workspace or
 * pending cleanup cannot erase an unresolved child. They never carry
 * credentials, prompts, full environment, or config: only process identity,
 * lifetime class, lifecycle state, and a bounded outcome string.
 *
 * Reconciliation only ever signals a recorded child once the original owner
 * incarnation is provably gone *and* the target still matches the recorded
 * child incarnation and executable role, revalidated immediately before each
 * destructive transition.
 *
 * Residual risk (design D5): that revalidation narrows but does not eliminate
 * the portable POSIX time-of-check/time-of-use window between an identity
 * probe and the delivered signal, especially on macOS. Reconciliation is a
 * best-effort lifecycle cleanup, never an atomic security boundary, and it is
 * never a reason to signal a PID that this recovery did not record. Unknown,
 * unreadable, or mismatched evidence stays non-destructive.
 */

import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { log } from "./log"
import {
  captureIdentity,
  defaultIdentityProbe,
  identityMismatchReason,
  sameIdentity,
  type IdentityProbe,
  type ProcessIdentity,
} from "./process-identity"
import { observedStopTarget, stopTarget, type StopOutcome, type StopPolicy } from "./process-stop"
import { isFound, readJsonFile, writeJsonFile } from "./repo-store"
import { convoyHome } from "./workspace"

export const PROCESS_RECORD_VERSION = 1

/** Only owned lifetimes participate in orphan reconciliation (design D1). */
export type RecordLifetime = "run" | "helper"

export type ProcessRecordState = "provisional" | "ready" | "stopping" | "unresolved"

export type ProcessRecord = {
  version: typeof PROCESS_RECORD_VERSION
  id: string
  lifetime: RecordLifetime
  state: ProcessRecordState
  createdAt: number
  updatedAt: number
  /** The process that owns the child's lifetime. Absent until captured. */
  owner?: ProcessIdentity
  /** The recorded server child. Absent in the pre-spawn provisional record. */
  child?: ProcessIdentity
  runId?: string
  url?: string
  /** Bounded last-stop outcome; never secrets, env, or prompts. */
  lastOutcome?: string
}

export function processRecordsDir(home = convoyHome()): string {
  return join(home, "processes")
}

export function newProcessRecord(input: { lifetime: RecordLifetime; id?: string; now?: number }): ProcessRecord {
  const now = input.now ?? Date.now()
  return {
    version: PROCESS_RECORD_VERSION,
    id: input.id ?? crypto.randomUUID(),
    lifetime: input.lifetime,
    state: "provisional",
    createdAt: now,
    updatedAt: now,
  }
}

/** Validator for one stored record, matching the repo's `validate<Record>` store convention. */
export function validateProcessRecord(value: unknown): ProcessRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<ProcessRecord>
  if (record.version !== PROCESS_RECORD_VERSION) return undefined
  if (typeof record.id !== "string") return undefined
  if (record.lifetime !== "run" && record.lifetime !== "helper") return undefined
  if (typeof record.createdAt !== "number") return undefined
  return value as ProcessRecord
}

export type ProcessRecordStore = {
  dir: string
  put(record: ProcessRecord): Promise<void>
  get(id: string): Promise<ProcessRecord | undefined>
  remove(id: string): Promise<void>
  list(): Promise<ProcessRecord[]>
  /** Runs `fn` under the record's exclusive lock. Returns undefined when the lock is contended. */
  withLock<T>(
    id: string,
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number; probe?: IdentityProbe; owner?: ProcessIdentity },
  ): Promise<T | undefined>
  readCursor(): Promise<string | undefined>
  writeCursor(id: string | undefined): Promise<void>
}

const recordPath = (dir: string, id: string) => join(dir, `${id}.json`)
const lockPath = (dir: string, id: string) => join(dir, `${id}.lock`)

export function createProcessRecordStore(dir = processRecordsDir()): ProcessRecordStore {
  return {
    dir,
    async put(record) {
      // 0700 keeps the evidence directory private; `writeJsonFile` publishes
      // atomically (temp + rename) with 0600, so a reader never sees a torn
      // record and the file never passes through a world-readable state.
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeJsonFile(recordPath(dir, record.id), record, { mode: 0o600 })
    },
    async get(id) {
      const read = await readJsonFile(recordPath(dir, id), validateProcessRecord)
      return isFound(read) ? read.value : undefined
    },
    async remove(id) {
      // File-only: a record is one JSON file, and a directory at that path
      // must never be recursively deleted by a stop/cleanup path.
      await unlink(recordPath(dir, id)).catch(() => {})
    },
    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const records: ProcessRecord[] = []
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        const parsed = await this.get(name.slice(0, -".json".length))
        if (parsed) records.push(parsed)
      }
      records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      return records
    },
    async withLock(id, fn, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 200
      const path = lockPath(dir, id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try {
          const handle = await open(path, "wx", 0o600)
          await handle.close()
          await writeLockOwner(path, opts.owner)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined
          // Fail closed: never unlink a lock while its owner may be alive.
          // A lock whose recorded owner is provably gone may be reclaimed.
          const reclaimed = await reclaimDeadLock(path, opts.probe)
          if (!reclaimed) {
            if (Date.now() >= deadline) return undefined
            await sleep(20)
          }
        }
      }
      try {
        return await fn()
      } finally {
        await unlink(path).catch(() => {})
      }
    },
    async readCursor() {
      try {
        return (await readFile(join(dir, ".cursor"), "utf8")).trim() || undefined
      } catch {
        return undefined
      }
    },
    async writeCursor(id) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, ".cursor"), id ?? "", { mode: 0o600 }).catch(() => {})
    },
  }
}

async function reclaimDeadLock(path: string, probe: IdentityProbe | undefined): Promise<boolean> {
  if (!probe) return false
  let info: { pid?: number; birth?: string }
  try {
    info = JSON.parse(await readFile(path, "utf8")) as { pid?: number; birth?: string }
  } catch {
    return false
  }
  if (!info.pid) return false
  const observation = await probe.observe(info.pid)
  if (observation.status !== "gone") return false
  await unlink(path).catch(() => {})
  return true
}

/** The owner block written into a lock file so a dead holder can be reclaimed. */
async function writeLockOwner(path: string, identity: ProcessIdentity | undefined): Promise<void> {
  await writeFile(path, JSON.stringify({ pid: identity?.pid, birth: identity?.birth }), { mode: 0o600 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconcileOutcome = {
  inspected: number
  removed: string[]
  stopped: string[]
  skipped: { id: string; reason: string }[]
  uncertain: { id: string; reason: string }[]
  deferred: string[]
}

export type ReconcileDeps = {
  store?: ProcessRecordStore
  probe?: IdentityProbe
  /** Signals a recorded child by pid; injectable so tests never touch real processes. */
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  policy?: StopPolicy
  maxRecords?: number
  budgetMs?: number
  now?: () => number
  /** Bounded diagnostic sink; defaults to the structured logger. */
  warn?: (line: string) => void
  controllerPid?: number
}

const defaultReconcileBudgets = { maxRecords: 32, budgetMs: 5_000 } as const

/**
 * Printed with an unresolved recovery so an operator cannot read reconciliation
 * as an atomic kill guarantee (design D5): identity is revalidated at each
 * destructive edge, but the POSIX probe-to-signal window is inherently racy.
 */
const reconcileToctouNotice =
  "identity is rechecked immediately before each signal, but the portable probe-to-signal window is not atomic; treat recovery as best-effort cleanup, not kill authority for unrecorded processes"

/**
 * Bounded pass over recorded run/helper lifetimes. Never throws and never
 * fails an unrelated launch: every per-record error becomes a `skipped` or
 * `uncertain` entry, and the caller's startup continues.
 */
export async function reconcileProcessRecords(deps: ReconcileDeps = {}): Promise<ReconcileOutcome> {
  const store = deps.store ?? createProcessRecordStore()
  const probe = deps.probe ?? defaultIdentityProbe()
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig))
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((line: string) => log.warn(line))
  const maxRecords = deps.maxRecords ?? defaultReconcileBudgets.maxRecords
  const budgetMs = deps.budgetMs ?? defaultReconcileBudgets.budgetMs
  const deadline = now() + budgetMs

  const outcome: ReconcileOutcome = { inspected: 0, removed: [], stopped: [], skipped: [], uncertain: [], deferred: [] }
  const all = await store.list()
  if (all.length === 0) return outcome

  // The lock owner is this process, so a crashed reconciler's lock can be
  // reclaimed by a later pass without ever unlinking a live worker's lock.
  const owner = await captureIdentity(process.pid, probe).catch(() => undefined)

  // Fair cursor: continue after the last inspected record so a long tail of
  // uncertain records is never starved and the oldest is never revisited
  // forever at the expense of newer ones.
  const cursor = await store.readCursor()
  const start = cursor ? (all.findIndex((record) => record.id === cursor) + 1) % all.length : 0

  let lastInspected: ProcessRecord | undefined
  let offset = 0
  let budgetExhausted = false
  for (; offset < all.length && outcome.inspected < maxRecords; offset++) {
    if (now() >= deadline) {
      budgetExhausted = true
      break
    }
    const record = all[(start + offset) % all.length]!
    lastInspected = record
    outcome.inspected++
    try {
      await reconcileOne(record, { store, probe, signal, policy: deps.policy, now, warn, ...(owner ? { owner } : {}), outcome })
    } catch (error) {
      outcome.uncertain.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  // Whatever remains unprocessed stays for a later pass, and the cursor now
  // points at the next record so the same head is not starved next time.
  if (budgetExhausted || offset < all.length) {
    for (let index = offset; index < all.length; index++) {
      outcome.deferred.push(all[(start + index) % all.length]!.id)
    }
  }
  if (lastInspected) await store.writeCursor(lastInspected.id)
  return outcome
}

async function reconcileOne(
  record: ProcessRecord,
  context: {
    store: ProcessRecordStore
    probe: IdentityProbe
    signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
    policy?: StopPolicy
    now: () => number
    warn: (line: string) => void
    owner?: ProcessIdentity
    outcome: ReconcileOutcome
  },
): Promise<void> {
  const { store, probe, signal, outcome, warn } = context

  await store.withLock(
    record.id,
    async () => {
      // Reread under the lock: another Convoy incarnation may have resolved it.
      const current = await store.get(record.id)
      if (!current) return
      if (current.lifetime !== "run" && current.lifetime !== "helper") {
        outcome.skipped.push({ id: current.id, reason: `lifetime ${current.lifetime} is not eligible for recovery` })
        return
      }
      if (!current.child) {
        outcome.uncertain.push({ id: current.id, reason: "record carries no child identity (legacy/incomplete); never a kill target" })
        // An incomplete record can never be resolved automatically; remove it
        // only if it is clearly ancient so the registry does not grow forever.
        if (context.now() - current.createdAt > 24 * 60 * 60 * 1_000) await store.remove(current.id)
        return
      }
      if (!current.owner) {
        outcome.uncertain.push({ id: current.id, reason: "record carries no owner identity; cannot prove owner death" })
        return
      }

      // Owner must be provably gone; a different process at the old PID is
      // not the original owner, and probe errors are uncertain.
      const ownerObservation = await probe.observe(current.owner.pid)
      if (ownerObservation.status === "alive") {
        if (sameIdentity(current.owner, ownerObservation.identity)) {
          outcome.skipped.push({ id: current.id, reason: "owner is still alive; detached execution is preserved" })
        } else {
          outcome.skipped.push({ id: current.id, reason: identityMismatchReason(current.owner, ownerObservation.identity) ?? "owner pid was reused" })
        }
        return
      }
      if (ownerObservation.status === "unknown") {
        outcome.uncertain.push({ id: current.id, reason: `owner identity could not be probed: ${ownerObservation.reason}` })
        return
      }

      // The target must still be the recorded child incarnation.
      const childObservation = await probe.observe(current.child.pid)
      if (childObservation.status === "gone") {
        await store.remove(current.id)
        outcome.removed.push(current.id)
        return
      }
      if (childObservation.status === "unknown") {
        outcome.uncertain.push({ id: current.id, reason: `child identity could not be probed: ${childObservation.reason}` })
        return
      }
      if (childObservation.status === "mismatch") {
        outcome.skipped.push({ id: current.id, reason: childObservation.reason })
        return
      }
      if (!sameIdentity(current.child, childObservation.identity)) {
        outcome.skipped.push({
          id: current.id,
          reason: identityMismatchReason(current.child, childObservation.identity) ?? "child pid was reused",
        })
        return
      }

      // Revalidate immediately before each destructive transition: TERM and
      // KILL both go through this verify hook.
      const verify = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
        const observed = await probe.observe(current.child!.pid)
        if (observed.status === "gone") return { ok: true }
        if (observed.status !== "alive") return { ok: false, reason: `child identity became ${observed.status}` }
        return sameIdentity(current.child!, observed.identity) ? { ok: true } : { ok: false, reason: "child incarnation changed before escalation" }
      }

      const target = observedStopTarget({
        pid: current.child.pid,
        observe: async () => {
          const observed = await probe.observe(current.child!.pid)
          return observed.status === "mismatch" ? "unknown" : observed.status
        },
        signal: (sig) => signal(current.child!.pid, sig),
        verify,
      })
      const stop = await stopTarget(target, context.policy)

      if (stop.status === "stopped") {
        await store.remove(current.id)
        outcome.stopped.push(current.id)
        outcome.removed.push(current.id)
        warn(
          `[processes] recovered orphan ${current.lifetime} server pid ${current.child.pid} (${stop.via}); record ${current.id} removed`,
        )
      } else {
        const stopping: ProcessRecord = {
          ...current,
          state: "unresolved",
          updatedAt: context.now(),
          lastOutcome: boundedOutcome(stop),
        }
        await store.put(stopping)
        outcome.uncertain.push({ id: current.id, reason: stop.reason })
        warn(`[processes] could not confirm stop for record ${current.id} at ${store.dir}; retained for a later pass: ${stop.reason}. ${reconcileToctouNotice}`)
      }
    },
    { probe, ...(context.owner ? { owner: context.owner } : {}) },
  )
}

function boundedOutcome(outcome: StopOutcome): string {
  const text = outcome.status === "stopped" ? `stopped (${outcome.via})` : `unresolved: ${outcome.reason}`
  return text.slice(0, 400)
}

/**
 * Publishes a record's child identity before readiness and returns it. A
 * record that cannot be persisted is a launch failure (fail closed): the
 * caller must fall back to bounded cleanup through the owned child handle.
 */
export async function publishChildIdentity(
  store: ProcessRecordStore,
  record: ProcessRecord,
  pid: number,
  probe: IdentityProbe,
): Promise<{ record: ProcessRecord; identity: ProcessIdentity } | undefined> {
  const identity = await captureIdentity(pid, probe)
  if (!identity) return undefined
  const next: ProcessRecord = { ...record, child: identity, state: "ready", updatedAt: Date.now() }
  await store.put(next)
  return { record: next, identity }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
