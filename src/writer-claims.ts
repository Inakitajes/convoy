import { join } from "node:path"

import { readJsonFile, removePath, withExclusiveLock, writeJsonFile, type StoreRead } from "./repo-store"

/**
 * Managed writer claims (change `worktree-control-center`, task 2.1):
 * extracted from the feature-lifecycle domain so launches, conversations, and
 * the future worktree operations all coordinate through the same generic
 * module. A claim is scoped to validated checkout identity — the repository
 * common dir plus the checked-out branch — and is independent of UI
 * attachment: closing a view never releases one, and only evidence that
 * execution stopped does (release by a matching owner, or stale-liveness
 * reconciliation).
 *
 * This is a bounded guarantee, not a general scheduler: it covers only
 * Convoy-managed writers. Arbitrary unmanaged external processes remain
 * outside it. Claims are checked before a writer starts; a live conflicting
 * claim refuses with the explicit control transition (attach to the run /
 * inspect), and a stale or uncertain one requires reconciliation evidence —
 * never unconditional takeover.
 *
 * Layout: <common-dir>/convoy/writer-claims/<branch-key>.json, written
 * owner-readable only (0600) — a claim names a checkout and an owning
 * process, which is coordination data, not public state.
 */

/** Bumped only for a wire-format change; claim records carry it like every stored record. */
export const writerClaimSchemaVersion = 1

export type WriterClaimKind = "pipeline" | "authoring"

/** One managed writer's claim on a checkout. */
export type WriterClaim = {
  schemaVersion: number
  /** The branch checked out at the claimed checkout (the claim's key). */
  branch: string
  /** The claimed checkout (canonical path at claim time). */
  checkoutPath: string
  kind: WriterClaimKind
  /** Pipeline claims carry the run id; authoring claims the session id. */
  owner?: string
  /** The PID of the Convoy process that owns the claim (liveness probe). */
  pid: number
  startedAt: number
  /** Refreshed by the owner while it believes it is writing. */
  heartbeatAt: number
}

/** How old a claim may get without a heartbeat before it is no longer trusted live. */
const claimFreshnessMs = 10 * 60 * 1000

function claimPath(commonDir: string, branch: string): string {
  // Branch names may contain `/`; the claim key is a flat file name, so the
  // key is the branch with separators escaped — never a raw path under the
  // record root.
  return join(commonDir, "convoy", "writer-claims", `${branch.replace(/\//g, "__")}.json`)
}

/** The path of one checkout's claim record (shared by the store and recovery tooling). */
export function writerClaimPath(commonDir: string, branch: string): string {
  return claimPath(commonDir, branch)
}

export function validateWriterClaim(value: unknown): WriterClaim | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== writerClaimSchemaVersion) return undefined
  if (typeof record.branch !== "string" || record.branch === "") return undefined
  if (typeof record.checkoutPath !== "string" || record.checkoutPath === "") return undefined
  if (record.kind !== "pipeline" && record.kind !== "authoring") return undefined
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return undefined
  if (typeof record.startedAt !== "number" || typeof record.heartbeatAt !== "number") return undefined
  return {
    schemaVersion: writerClaimSchemaVersion,
    branch: record.branch,
    checkoutPath: record.checkoutPath,
    kind: record.kind,
    ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
    pid: record.pid,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
  }
}

export async function readWriterClaim(commonDir: string, branch: string): Promise<StoreRead<WriterClaim>> {
  return readJsonFile(claimPath(commonDir, branch), validateWriterClaim, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > writerClaimSchemaVersion,
  })
}

/** Whether the claim's owning process is still alive on this machine. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ESRCH") return false
    // EPERM means the process exists but is owned by someone else — treat as alive.
    return code === "EPERM"
  }
}

/** The claim's liveness assessment: stale or uncertain needs reconciliation. */
export function claimLiveness(claim: WriterClaim, now = Date.now()): "live" | "stale" | "uncertain" {
  if (pidAlive(claim.pid)) {
    // An alive PID with a very old heartbeat is uncertain: the process may
    // have detached the write work (e.g. a finished coordinator's parent).
    return now - claim.heartbeatAt > claimFreshnessMs ? "uncertain" : "live"
  }
  return now - claim.heartbeatAt > claimFreshnessMs ? "stale" : "uncertain"
}

/**
 * The outcome of an acquisition attempt. The three outcomes are
 * distinguished by `status` — never by key presence — so a refused writer
 * (with the blocking claim attached for guidance) can never be mistaken for
 * a successful acquisition.
 */
export type WriterClaimAcquisition =
  | { status: "acquired"; claim: WriterClaim }
  | { status: "conflict"; existing: WriterClaim }
  | { status: "uncertain"; existing?: WriterClaim }

/**
 * Acquires the writer claim for a checkout, refusing a live conflicting
 * claim with the transition guidance instead of starting a second writer.
 * A stale claim (dead PID past the freshness window) is reconciled —
 * replaced — because it is provably not writing. An uncertain claim is
 * never taken over, except when `reconcileOwner` names the exact owner of
 * the existing claim: re-opening a conversation it already holds the claim
 * for is the same writer continuing, not a takeover.
 */
export async function acquireWriterClaim(input: {
  commonDir: string
  branch: string
  checkoutPath: string
  kind: WriterClaimKind
  owner?: string
  pid?: number
  /** Take over an existing claim only when its owner matches this value. */
  reconcileOwner?: string
}): Promise<WriterClaimAcquisition> {
  let outcome: WriterClaimAcquisition = { status: "uncertain" }
  await withExclusiveLock(join(input.commonDir, "convoy", "writer-claims"), async () => {
    const read = await readWriterClaim(input.commonDir, input.branch)
    if (read.status === "found") {
      const existing = read.value
      const sameOwnerContinues =
        input.reconcileOwner !== undefined && existing.owner === input.reconcileOwner && existing.kind === input.kind
      if (!sameOwnerContinues) {
        const liveness = claimLiveness(existing)
        if (liveness === "live") {
          outcome = { status: "conflict", existing }
          return
        }
        if (liveness === "uncertain") {
          outcome = { status: "uncertain", existing }
          return
        }
      }
      // Stale (or the same writer continuing): reconciled and replaced below.
    }
    // An unreadable/corrupt claim record is not evidence of a live writer,
    // but it is also not clean state: refuse rather than overwrite evidence.
    if (read.status === "corrupt" || read.status === "unsupported" || read.status === "unreadable") {
      outcome = { status: "uncertain" }
      return
    }
    const now = Date.now()
    const claim: WriterClaim = {
      schemaVersion: writerClaimSchemaVersion,
      branch: input.branch,
      checkoutPath: input.checkoutPath,
      kind: input.kind,
      ...(input.owner ? { owner: input.owner } : {}),
      pid: input.pid ?? process.pid,
      startedAt: now,
      heartbeatAt: now,
    }
    await writeJsonFile(claimPath(input.commonDir, input.branch), claim, { mode: 0o600 })
    outcome = { status: "acquired", claim }
  })
  return outcome
}

/**
 * Releases the claim whose owner matches (id or pid). A release by a
 * different owner is a no-op, so a late exit from a superseded instance can
 * never drop a live writer's claim.
 */
export async function releaseWriterClaim(input: { commonDir: string; branch: string; ownerPid?: number; owner?: string }): Promise<boolean> {
  let released = false
  await withExclusiveLock(join(input.commonDir, "convoy", "writer-claims"), async () => {
    const read = await readWriterClaim(input.commonDir, input.branch)
    if (read.status !== "found") return
    const mine = (input.owner !== undefined && read.value.owner === input.owner) || (input.ownerPid !== undefined && read.value.pid === input.ownerPid)
    if (!mine) return
    await removePath(claimPath(input.commonDir, input.branch))
    released = true
  })
  return released
}

/**
 * Hands the checkout's claim to a new owner without ever dropping it: the
 * propose flow claims before its session exists (so a concurrent writer is
 * refused before any writer work starts) and re-owns the claim with the
 * session id once created, keeping the idle release and conflict guidance
 * naming the actual writer. Only the claiming process may re-own — a claim
 * held by another PID (or missing) is left untouched.
 */
export async function reownWriterClaim(input: { commonDir: string; branch: string; owner: string; ownerPid?: number }): Promise<boolean> {
  let reowned = false
  await withExclusiveLock(join(input.commonDir, "convoy", "writer-claims"), async () => {
    const read = await readWriterClaim(input.commonDir, input.branch)
    if (read.status !== "found") return
    if (read.value.pid !== (input.ownerPid ?? process.pid)) return
    const updated: WriterClaim = { ...read.value, owner: input.owner, heartbeatAt: Date.now() }
    await writeJsonFile(claimPath(input.commonDir, input.branch), updated, { mode: 0o600 })
    reowned = true
  })
  return reowned
}

/** Guidance for a refused writer start, consumed by launch paths and menus. */
export function writerConflictGuidance(claim: WriterClaim): string[] {
  const what = claim.kind === "pipeline" ? `run ${claim.owner ?? "(unknown)"} is executing` : `authoring conversation ${claim.owner ?? "(unknown)"} is active`
  return [
    `a managed writer already owns "${claim.branch}" at ${claim.checkoutPath}: ${what}`,
    "attach to it from the runs browser (`convoy runs`) or stop it explicitly before starting another writer here",
  ]
}
