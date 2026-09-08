import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { execFile } from "./git"

/**
 * Generic repository-scoped storage primitives (change
 * `worktree-control-center`, task 2.1): extracted from the feature-lifecycle
 * store so the worktree control center can persist coordination data without
 * importing the feature domain. The feature-lifecycle module re-exports these
 * under their original names, so its consumers and tests keep working while
 * the generic layer lives in its own module.
 *
 * Every read returns a typed result (missing/corrupt/unsupported/unreadable
 * are distinct — never collapsed into absence), writes are atomic
 * (temp-file + rename), and read-modify-write cycles serialize through an
 * exclusive-create sidecar lock with stale-lock theft so recovery is always
 * possible.
 */

/**
 * Every read returns a typed result: missing, corrupt (parseable-but-
 * invalid), unsupported (a newer schema we must not interpret), and
 * unreadable (I/O or permission failure) are distinct.
 */
export type StoreRead<T> =
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; schemaVersion: unknown }
  | { status: "unreadable"; reason: string }

export type StoreReadError = Extract<StoreRead<never>, { status: "corrupt" | "unsupported" | "unreadable" }>

/** True when a read proves the record exists and validated; false otherwise. */
export function isFound<T>(read: StoreRead<T>): read is { status: "found"; value: T } {
  return read.status === "found"
}

/** Whether `path` exists (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Parses one JSON document against a validator. `unsupported` is decided by
 * the caller's schema gate — usually a `schemaVersion` comparison — while
 * malformed JSON is `corrupt` and I/O failure is `unreadable`.
 */
export async function readJsonFile<T>(
  path: string,
  validate: (value: unknown) => T | undefined,
  options: { unsupported?: (value: Record<string, unknown>) => boolean } = {},
): Promise<StoreRead<T>> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") return { status: "missing" }
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "corrupt", reason: "record is not a JSON object" }
  }
  if (options.unsupported?.(parsed as Record<string, unknown>)) {
    return { status: "unsupported", schemaVersion: (parsed as Record<string, unknown>).schemaVersion }
  }
  const value = validate(parsed)
  if (value === undefined) return { status: "corrupt", reason: "record failed validation" }
  return { status: "found", value }
}

/**
 * Writes a JSON document atomically: content lands at `<path>.<uuid>.tmp`
 * first and is renamed into place, so a crash mid-write never exposes a torn
 * record. The caller is responsible for conflict detection (see
 * `withExclusiveLock`) and for refusing to write when required evidence
 * cannot be persisted.
 *
 * `mode` restricts the record's permissions at creation (e.g. `0o600` for
 * coordination data under `<git-common-dir>/convoy/`): the temp file is
 * created with it, so the renamed record never passes through a
 * world-readable state. Ignored where the platform has no permission bits.
 */
export async function writeJsonFile(path: string, value: unknown, options: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    if (options.mode !== undefined) {
      const handle = await open(tmp, "w", options.mode)
      try {
        await handle.write(JSON.stringify(value, null, 2) + "\n")
      } finally {
        await handle.close()
      }
    } else {
      await Bun.write(tmp, JSON.stringify(value, null, 2) + "\n")
    }
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Removes a path best-effort; used only for superseded scratch state. */
export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true }).catch(() => {})
}

/**
 * The repository's Git common dir, or undefined outside a repository. Every
 * worktree of one repository shares it, which is what makes repository-scoped
 * coordination data shared across checkouts.
 */
export async function repoCommonDir(cwd: string): Promise<string | undefined> {
  return execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFailure: true }).then(
    (result) => (result.exitCode === 0 ? result.stdout.trim() || undefined : undefined),
    () => undefined,
  )
}

/** Opaque UUID form used for identities that must never encode names. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * True when `value` is a single, safe path segment: non-empty, not `.`/`..`,
 * not absolute (POSIX or Windows drive), and containing no path separator.
 * A corrupt or hostile record must never escape its root when a read joins
 * it onto a checkout path.
 */
export function isSafePathSegment(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false
  if (value.startsWith("/") || value.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.includes("/") && !value.includes("\\")
}

/**
 * True when `value` is a repo-relative path that stays within its root: not
 * absolute (POSIX or Windows drive), and containing no `..` segment.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).some((segment) => segment === "..")
}

/**
 * Serializes read-modify-write cycles on one record directory (task 2.1):
 * only one writer proceeds at a time; a competing writer waits, then either
 * proceeds after the lock is released or steals a stale lock left by a
 * crashed writer after `staleMs`. The lock is held only for the duration of
 * the callback and always released, including on throw.
 */
export async function withExclusiveLock<T>(
  recordDir: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  const lockPath = join(recordDir, ".lock")
  await mkdir(recordDir, { recursive: true })
  const staleMs = options.staleMs ?? 30_000
  let handle
  for (;;) {
    try {
      // Owner-readable only: the lock carries the holder's PID.
      handle = await open(lockPath, "wx", 0o600)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== "EEXIST") throw error
      let age = 0
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs
      } catch {
        continue
      }
      if (age <= staleMs) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
        continue
      }
      await rm(lockPath, { force: true }).catch(() => {})
    }
  }
  try {
    await handle!.write(`${process.pid}\n`)
    return await fn()
  } finally {
    await handle!.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}
