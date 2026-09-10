/**
 * The lifecycle store (capability `feature-lifecycle`) is now a compatibility
 * layer over the generic repository storage (`src/repo-store.ts`), extracted
 * in change `worktree-control-center` task 2.1 so the worktree control center
 * can share atomic writes, typed reads, and mutation locks without importing
 * the feature domain. This module keeps the original names and layout
 * (`<git-common-dir>/convoy/…`, repository UUID, feature records) for every
 * existing consumer until the feature domain itself is retired (task 8.4).
 *
 * Layout:
 *
 *   <git-common-dir>/convoy/
 *     repository.json                            # repository UUID + schema version
 *     features/<feature-id>/feature.json         # current association + revision
 *     features/<feature-id>/attempts/<attempt-id>/journal.json
 *     features/<feature-id>/receipts/<attempt-id>.json
 *
 * Identities are opaque UUIDs — branch/change spellings are never encoded into
 * filenames. Reads are strictly read-only: nothing here creates the repository
 * UUID, locks, or any other file as a side effect of inspection.
 */

import { join } from "node:path"

import {
  isFound,
  isSafePathSegment,
  isUuid,
  pathExists,
  readJsonFile,
  removePath,
  repoCommonDir,
  withExclusiveLock,
  writeJsonFile,
  type StoreRead,
  type StoreReadError,
} from "../repo-store"

export const lifecycleSchemaVersion = 1
export { isFound, isSafePathSegment, isUuid, pathExists, readJsonFile, removePath, writeJsonFile }
export type { StoreRead, StoreReadError }

/** The repository UUID record (D1): membership proof for everything under `convoy/`. */
export type RepositoryRecord = {
  schemaVersion: number
  /** Opaque UUID for this repository's shared record set. */
  repositoryId: string
  createdAt: number
}

/** The repository's Git common dir, or undefined outside a repository. */
export async function lifecycleCommonDir(cwd: string): Promise<string | undefined> {
  return repoCommonDir(cwd)
}

/** `<commonDir>/convoy` — the record set root. */
export function lifecycleRoot(commonDir: string): string {
  return join(commonDir, "convoy")
}

function repositoryRecordPath(commonDir: string): string {
  return join(lifecycleRoot(commonDir), "repository.json")
}

export function validateRepositoryRecord(value: unknown): RepositoryRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.repositoryId !== "string" || !isUuid(record.repositoryId)) return undefined
  if (typeof record.createdAt !== "number") return undefined
  return { schemaVersion: lifecycleSchemaVersion, repositoryId: record.repositoryId, createdAt: record.createdAt }
}

/**
 * Reads the repository record. Missing means the store has never been
 * initialized — callers that only inspect (board, specs viewer) must treat
 * that as "no registered features" and never create the file (design D1).
 */
export async function readRepositoryRecord(commonDir: string): Promise<StoreRead<RepositoryRecord>> {
  return readJsonFile(repositoryRecordPath(commonDir), validateRepositoryRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
}

/**
 * Creates the repository record exactly once. An existing record of any
 * version is returned untouched — even an unreadable one, because
 * overwriting it would silently orphan every feature recorded under the old
 * identity (fail closed).
 */
export async function ensureRepositoryRecord(commonDir: string): Promise<StoreRead<RepositoryRecord>> {
  const existing = await readRepositoryRecord(commonDir)
  if (existing.status !== "missing") return existing
  const record: RepositoryRecord = {
    schemaVersion: lifecycleSchemaVersion,
    repositoryId: crypto.randomUUID(),
    createdAt: Date.now(),
  }
  try {
    await writeJsonFile(repositoryRecordPath(commonDir), record)
  } catch (error) {
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) }
  }
  return { status: "found", value: record }
}

/** True when `value` is a repo-relative path that stays within its root. */
export function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).some((segment) => segment === "..")
}

/**
 * Serializes read-modify-write cycles on one feature record. The lock is an
 * exclusive-create sidecar next to the record; it is held only for the
 * duration of the callback and always released, including on throw. A stale
 * lock from a crashed writer is stolen after `staleMs` so recovery is always
 * possible.
 */
export async function withFeatureLock<T>(
  featureDir: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  return withExclusiveLock(featureDir, fn, options)
}
