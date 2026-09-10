import { join } from "node:path"

import { readJsonFile, withExclusiveLock, writeJsonFile, type StoreRead } from "./repo-store"
import type { AuthoringSessionRef } from "./conversations"
import { validateCheckoutTarget, type ObservedCheckoutTarget } from "./worktree-target"

/**
 * Optional, non-authoritative navigation hints (design D9, "Navigation/
 * session hints"): the last Home selection and the last authoring conversation
 * reference per checkout, stored under `<git-common-dir>/convoy/session-hints.json`.
 *
 * These are UX hints only — best-effort, never authority. A hint cannot create
 * a Worktrees row, own a change, or authorize a mutation: every consumer
 * re-verifies the stored target against live Git (registration, administrative
 * directory, branch — never a stale HEAD, which advances with ordinary work)
 * and, for conversations, against the harness, before any use. A hint that no
 * longer verifies is explained and dropped, never silently replaced.
 *
 * This file is NOT legacy feature data: the previewed legacy cleanup never
 * lists it, and resolving it is never required by any operation.
 */

export const sessionHintsSchemaVersion = 1

/** The target facts a hint keeps so continuity can be verified later. */
export type HintTarget = {
  checkoutPath: string
  gitDir?: string
  commonDir: string
  branch?: string
  detached: boolean
}

export type SessionHints = {
  schemaVersion: number
  /** The last Home selection (home-launcher delta: restored only when verifiable). */
  lastSelection?: HintTarget & { savedAt: number }
  /** The last authoring conversation reference per canonical checkout path. */
  conversations?: Record<string, { ref: AuthoringSessionRef; target: HintTarget; savedAt: number }>
}

function hintsPath(commonDir: string): string {
  return join(commonDir, "convoy", "session-hints.json")
}

function validateHints(value: unknown): SessionHints | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== sessionHintsSchemaVersion) return undefined
  return record as unknown as SessionHints
}

export async function readSessionHints(commonDir: string): Promise<StoreRead<SessionHints>> {
  return readJsonFile(hintsPath(commonDir), validateHints, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > sessionHintsSchemaVersion,
  })
}

/** Read-modify-write under the store's exclusive lock; hints are best-effort, so a failed save is swallowed. */
async function updateHints<T>(commonDir: string, fn: (hints: SessionHints) => T): Promise<T | undefined> {
  try {
    // The lock lives beside the hints file (withExclusiveLock takes the
    // containing directory); the convoy root is otherwise unlocked.
    return await withExclusiveLock(join(commonDir, "convoy"), async () => {
      const read = await readSessionHints(commonDir)
      const hints: SessionHints = read.status === "found" ? read.value : { schemaVersion: sessionHintsSchemaVersion }
      const result = fn(hints)
      await writeJsonFile(hintsPath(commonDir), hints)
      return result
    })
  } catch {
    return undefined
  }
}

/** Records the observed checkout as the last Home selection (call only with a freshly observed target). */
export async function saveLastSelection(commonDir: string, target: ObservedCheckoutTarget): Promise<void> {
  await updateHints(commonDir, (hints) => {
    hints.lastSelection = {
      checkoutPath: target.checkoutPath,
      ...(target.gitDir ? { gitDir: target.gitDir } : {}),
      commonDir: target.commonDir,
      ...(target.branch !== undefined ? { branch: target.branch } : {}),
      detached: target.detached,
      savedAt: Date.now(),
    }
    return true
  })
}

/** Records the conversation reference for a checkout (call only with a freshly observed target). */
export async function saveConversationRef(commonDir: string, target: ObservedCheckoutTarget, ref: AuthoringSessionRef): Promise<void> {
  await updateHints(commonDir, (hints) => {
    hints.conversations = hints.conversations ?? {}
    hints.conversations[target.checkoutPath] = {
      ref,
      target: {
        checkoutPath: target.checkoutPath,
        ...(target.gitDir ? { gitDir: target.gitDir } : {}),
        commonDir: target.commonDir,
        ...(target.branch !== undefined ? { branch: target.branch } : {}),
        detached: target.detached,
      },
      savedAt: Date.now(),
    }
    return true
  })
}

/** Drops one checkout's conversation hint (the linked session no longer verifies). */
export async function clearConversationRef(commonDir: string, checkoutPath: string): Promise<void> {
  await updateHints(commonDir, (hints) => {
    if (!hints.conversations) return false
    delete hints.conversations[checkoutPath]
    return true
  })
}

/**
 * Re-verifies a stored hint target against live Git: same repository, same
 * Git administrative directory (the registration — proof of the same checkout
 * incarnation, so a removed-and-recreated path is refused), same branch or
 * detached state. HEAD is deliberately not compared: it advances with
 * ordinary work and says nothing about continuity.
 */
export async function verifyHintTarget(stored: HintTarget): Promise<{ ok: true; target: ObservedCheckoutTarget } | { ok: false; reason: string }> {
  try {
    const result = await validateCheckoutTarget({
      checkoutPath: stored.checkoutPath,
      ...(stored.gitDir ? { gitDir: stored.gitDir } : {}),
      commonDir: stored.commonDir,
      ...(stored.branch !== undefined ? { branch: stored.branch } : {}),
      detached: stored.detached,
      head: undefined,
    })
    if (result.ok) return result
    return { ok: false, reason: result.reason }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The stored conversation reference for a checkout, when its target still
 * verifies. `undefined` when no hint exists or the checkout's continuity
 * cannot be proved (path reuse, removal, branch switch) — the caller then
 * treats the checkout as having no resumable conversation.
 */
export async function readVerifiableConversationRef(
  commonDir: string,
  checkoutPath: string,
): Promise<{ ref: AuthoringSessionRef; target: ObservedCheckoutTarget } | undefined> {
  const read = await readSessionHints(commonDir).catch(() => ({ status: "unreadable" as const, reason: "hints unreadable" }))
  if (read.status !== "found") return undefined
  const entry = read.value.conversations?.[checkoutPath]
  if (!entry) return undefined
  const verification = await verifyHintTarget(entry.target)
  if (!verification.ok) return undefined
  return { ref: entry.ref, target: verification.target }
}
