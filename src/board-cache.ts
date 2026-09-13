import { createHash } from "node:crypto"
import { join } from "node:path"

import { realpathSafe } from "./git"
import { readJsonFile, writeJsonFile, type StoreRead } from "./repo-store"
import { convoyHome } from "./workspace"
import type { ControlBoard } from "./control-board"

/**
 * The repository-scoped board cache (change `live-board-cache-and-refresh`,
 * design D1/D2): one JSON document per repository under
 * `~/.convoy/cache/board/<key>.json`, keyed by the realpath'd Git common dir
 * so every worktree and every Convoy window of one repository shares it while
 * distinct clones stay separate.
 *
 * The document is disposable: a missing, corrupt, unsupported-version, or
 * unreadable cache is ignored and triggers a cold load, never an error. It
 * carries the schema version plus each stored observation's collection time
 * and unknown reason (through the `ControlBoard` itself), so a cached board
 * renders with honest freshness.
 */

export const boardCacheSchemaVersion = 1

/** Per-checkout change-content fingerprint persisted with the snapshot. */
export type CheckoutFingerprints = Record<string, string | undefined>

export type BoardSnapshot = {
  schemaVersion: number
  /** Stable hash of the realpath'd Git common dir (see `boardCacheKey`). */
  repoKey: string
  commonDir: string
  /** When the board was assembled (epoch ms) — the age the UI discloses. */
  builtAt: number
  board: ControlBoard
  /** `checkout path -> change-content token`; unchanged tokens reuse prior facts. */
  fingerprints: CheckoutFingerprints
  /** Run-history fingerprint at build time; unchanged means no run-history read. */
  runsFingerprint?: string
}

/** The per-repository cache directory (a disposable, user-scoped location). */
export function boardCacheDir(): string {
  return join(convoyHome(), "cache", "board")
}

/**
 * A stable key for one repository, derived from its realpath'd Git common
 * directory: every worktree of one repository resolves to the same key, and
 * two clones (different common dirs) resolve to different keys.
 */
export function boardCacheKey(commonDir: string): string {
  const normalized = commonDir.replace(/\/+$/, "") || commonDir
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32)
}

/** The absolute cache path for a repository's common dir. */
export function boardCachePath(commonDir: string): string {
  return join(boardCacheDir(), `${boardCacheKey(commonDir)}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateSnapshot(value: unknown): BoardSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (value.schemaVersion !== boardCacheSchemaVersion) return undefined
  if (typeof value.repoKey !== "string" || typeof value.commonDir !== "string") return undefined
  if (typeof value.builtAt !== "number") return undefined
  const board = value.board
  if (!isRecord(board) || !Array.isArray(board.worktrees)) return undefined
  const fingerprints = value.fingerprints
  if (fingerprints !== undefined && !isRecord(fingerprints)) return undefined
  return value as unknown as BoardSnapshot
}

/**
 * Reads a repository's cached board. Every non-`found` status — missing,
 * corrupt, unsupported schema, unreadable — maps to `undefined`: a bad cache
 * is treated as no cache and never fails the Home open.
 */
export async function loadBoardSnapshot(commonDir: string): Promise<BoardSnapshot | undefined> {
  const read: StoreRead<BoardSnapshot> = await readJsonFile(boardCachePath(commonDir), validateSnapshot, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > boardCacheSchemaVersion,
  })
  return read.status === "found" ? read.value : undefined
}

/**
 * Whether two snapshots differ materially (board facts, fingerprints, or the
 * run-history token). Volatile collection times are deliberately excluded:
 * `builtAt` and every observation's `collectedAt` advance on each cheap probe,
 * and a periodic refresh that observed the same repository state must not
 * churn the cache.
 */
export function snapshotMateriallyChanged(next: BoardSnapshot, prior: BoardSnapshot | undefined): boolean {
  if (!prior) return true
  if (next.repoKey !== prior.repoKey) return true
  if (next.runsFingerprint !== prior.runsFingerprint) return true
  if (!sameFingerprints(next.fingerprints, prior.fingerprints)) return true
  return JSON.stringify(stripVolatile(next.board)) !== JSON.stringify(stripVolatile(prior.board))
}

/** A deep copy with the volatile `collectedAt` timestamps removed (comparison only). */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === "collectedAt") continue
      out[key] = stripVolatile(entry)
    }
    return out
  }
  return value
}

function sameFingerprints(a: CheckoutFingerprints, b: CheckoutFingerprints): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/**
 * Writes the cache atomically (temp file + rename, `0o600`) only when the
 * snapshot changed materially. A failure is swallowed by callers: the cache is
 * disposable and must never fail the board.
 */
export async function saveBoardSnapshot(snapshot: BoardSnapshot, prior?: BoardSnapshot): Promise<boolean> {
  if (!snapshotMateriallyChanged(snapshot, prior)) return false
  await writeJsonFile(boardCachePath(snapshot.commonDir), snapshot, { mode: 0o600 })
  return true
}

/** The realpath'd common dir used for keying; falls back to the raw value. */
export async function normalizeCommonDir(commonDir: string): Promise<string> {
  return (await realpathSafe(commonDir)) || commonDir
}
