import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { execFile } from "./git"
import { isOpenSpecChangeId, openspecDirName } from "./openspec"

/**
 * The shared read-only OpenSpec task-count query (change
 * `worktree-control-center`): `openspec list --json` when the CLI answers in
 * the given checkout, checkbox parsing of each change's `tasks.md` otherwise.
 * Used by the control board's rows, the checkout-local readers, and close's
 * preflight — one implementation, never a duplicated rule.
 */

export type BoardTasks = { done: number; total: number }

/** `openspec list --json` when the CLI answers; checkbox parsing otherwise. */
export async function openspecTaskCounts(dir: string): Promise<ReadonlyMap<string, BoardTasks>> {
  return (await taskCountsFromOpenspecCli(dir)) ?? (await taskCountsFromTasksFiles(dir))
}

/**
 * `openspec list --json` — the tool that owns OpenSpec state counts tasks. A
 * missing CLI binary throws at spawn time (not a non-zero exit), so the spawn
 * itself is guarded: absence means the checkbox fallback serves, exactly like
 * a non-zero exit or an unexpected output shape.
 */
async function taskCountsFromOpenspecCli(dir: string): Promise<ReadonlyMap<string, BoardTasks> | undefined> {
  let result
  try {
    result = await execFile("openspec", ["list", "--json"], { cwd: dir, allowFailure: true })
  } catch {
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  try {
    const parsed = JSON.parse(result.stdout) as { changes?: Array<{ name?: string; completedTasks?: number; totalTasks?: number }> }
    if (!Array.isArray(parsed.changes)) return undefined
    const out = new Map<string, BoardTasks>()
    for (const change of parsed.changes) {
      if (typeof change.name !== "string") continue
      out.set(change.name, { done: change.completedTasks ?? 0, total: change.totalTasks ?? 0 })
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * Fallback when the CLI is absent or its output changed shape: count the
 * checkbox states in each change's `tasks.md` directly. Same numbers, one
 * file read per change, no CLI dependency.
 */
async function taskCountsFromTasksFiles(dir: string): Promise<ReadonlyMap<string, BoardTasks>> {
  const out = new Map<string, BoardTasks>()
  const ids = await readdir(join(dir, openspecDirName, "changes")).catch(() => [])
  for (const id of ids.filter(isOpenSpecChangeId)) {
    const body = await readFile(join(dir, openspecDirName, "changes", id, "tasks.md"), "utf8").catch(() => undefined)
    if (body === undefined) continue
    const total = (body.match(/^\s*[-*+]\s+\[[ xX]\]/gm) ?? []).length
    const done = (body.match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length
    out.set(id, { done, total })
  }
  return out
}
