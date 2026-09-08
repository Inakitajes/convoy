import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"

import { openspecDirName } from "./openspec"

/**
 * Explicit ordered checkout-local change selection (change
 * `worktree-control-center`, task 1.6, design D3): the reviewed inputs an
 * action (a run, an archive batch) operates on. Selection exists only in the
 * reviewed operation inputs and their frozen history — never in a live
 * contract registry, and never expanded by file presence, inherited copies,
 * or same-id matches in other checkouts. A singleton suggestion must be
 * explicitly accepted before it becomes a selection; an empty selection is
 * valid only through the explicit manual/no-change mode. Archive-batch
 * selection is a separate input from whole-branch Git scope — callers never
 * derive one from the other.
 */

/** One explicitly selected local change: id plus its local source path in the selected checkout. */
export type SelectedChangeInput = {
  changeId: string
  /** Absolute path of the change directory inside the selected checkout. */
  sourcePath: string
}

/** A selected input with its frozen content snapshot, kept only while the operation is unresolved. */
export type FrozenSelectedChange = SelectedChangeInput & {
  /** Content read at freeze time; contentHash binds the snapshot to its bytes. */
  snapshot?: { content: string; contentHash: string }
}

/**
 * The explicit input mode for a reviewed action: either manual/no-change, or
 * an ordered operator-selected list. There is no third implicit mode — a
 * launch or archive without `manual` must carry its selections explicitly.
 */
export type ChangeSelectionInput = { mode: "manual" } | { mode: "selected"; changes: readonly SelectedChangeInput[] }

export type SelectionValidation =
  | { ok: true; mode: "manual"; changes: readonly [] }
  | { ok: true; mode: "selected"; changes: readonly SelectedChangeInput[] }
  | { ok: false; reason: string; changeId?: string }

/** The local directory that must hold a selected change in the checkout. */
export function expectedSourcePath(checkout: string, changeId: string): string {
  return join(resolve(checkout), openspecDirName, "changes", changeId)
}

/**
 * Validates a selection input against the selected checkout: manual mode
 * must be explicit (an empty `selected` list is not manual), selected
 * changes must be distinct, and every source path must exist right now in
 * the checkout and name the selected change. Order is preserved verbatim —
 * B-then-A stays B-then-A. Stale or missing inputs refuse with the change
 * named, never substituted.
 */
export async function validateChangeSelection(checkout: string, input: ChangeSelectionInput): Promise<SelectionValidation> {
  if (input.mode === "manual") {
    return { ok: true, mode: "manual", changes: [] }
  }
  if (input.changes.length === 0) {
    return {
      ok: false,
      reason: 'selected mode with no changes: pass mode "manual" explicitly for a no-change run or empty archive batch',
    }
  }

  const seen = new Map<string, SelectedChangeInput>()
  for (const change of input.changes) {
    if (!change.changeId) return { ok: false, reason: "a selected change has an empty change id" }
    const duplicate = seen.get(change.changeId)
    if (duplicate) {
      return { ok: false, changeId: change.changeId, reason: `change ${change.changeId} is selected more than once` }
    }
    seen.set(change.changeId, change)
  }

  const checkoutRoot = resolve(checkout)
  for (const change of input.changes) {
    if (!change.sourcePath) {
      return { ok: false, changeId: change.changeId, reason: `change ${change.changeId} has no source path` }
    }
    if (!isAbsolute(change.sourcePath)) {
      return { ok: false, changeId: change.changeId, reason: `change ${change.changeId} source path must be absolute` }
    }
    const resolved = resolve(change.sourcePath)
    if (!within(resolved, checkoutRoot)) {
      return { ok: false, changeId: change.changeId, reason: `change ${change.changeId} source ${resolved} is outside the selected checkout ${checkoutRoot}` }
    }
    const expected = expectedSourcePath(checkoutRoot, change.changeId)
    if (resolved !== expected) {
      return {
        ok: false,
        changeId: change.changeId,
        reason: `change ${change.changeId} must be selected at its checkout-local source ${expected}, not ${resolved}`,
      }
    }
    try {
      const info = await stat(resolved)
      if (!info.isDirectory()) {
        return { ok: false, changeId: change.changeId, reason: `selected source for ${change.changeId} is not a directory: ${resolved}` }
      }
    } catch {
      return {
        ok: false,
        changeId: change.changeId,
        reason: `selected change ${change.changeId} is missing from the execution checkout (${resolved}); reselect instead of substituting another copy`,
      }
    }
    if (basename(resolved) !== change.changeId) {
      return { ok: false, changeId: change.changeId, reason: `source directory ${resolved} does not name change ${change.changeId}` }
    }
  }

  return { ok: true, mode: "selected", changes: input.changes.map((change) => ({ changeId: change.changeId, sourcePath: change.sourcePath })) }
}

function within(candidate: string, root: string): boolean {
  if (candidate === root) return false
  const rel = candidate.startsWith(root + "/") ? candidate.slice(root.length + 1) : undefined
  return rel !== undefined && rel.length > 0
}

/** A singleton the UI may suggest — never a selection. */
export type SingletonSuggestion = {
  kind: "singleton"
  changeId: string
  sourcePath: string
}

/**
 * When exactly one active local change exists, the launcher may suggest it.
 * The suggestion is inert: it becomes a selection only through
 * `acceptSingletonSuggestion`, which is the explicit-acceptance boundary.
 * Zero or several changes produce no suggestion at all.
 */
export function suggestSingleton(changes: readonly { changeId: string; sourcePath: string }[]): SingletonSuggestion | undefined {
  if (changes.length !== 1) return undefined
  const only = changes[0]!
  return { kind: "singleton", changeId: only.changeId, sourcePath: only.sourcePath }
}

/**
 * The only path from a suggestion to a selection. Takes the suggestion
 * object itself (not an id string) so a caller cannot "accept" a change it
 * never saw suggested.
 */
export function acceptSingletonSuggestion(suggestion: SingletonSuggestion): SelectedChangeInput {
  return { changeId: suggestion.changeId, sourcePath: suggestion.sourcePath }
}

/**
 * Freezes selected inputs for an unresolved operation: reads each selected
 * proposal and binds its content with a hash, so a later retry detects a
 * changed source instead of silently consuming edited files. Returns the
 * per-change freeze failure rather than dropping that change.
 */
export async function freezeSelectedInputs(
  changes: readonly SelectedChangeInput[],
  read: (path: string) => Promise<string>,
): Promise<{ ok: true; frozen: FrozenSelectedChange[] } | { ok: false; changeId: string; reason: string }> {
  const frozen: FrozenSelectedChange[] = []
  for (const change of changes) {
    try {
      const content = await read(join(change.sourcePath, "proposal.md"))
      const contentHash = createHash("sha256").update(content).digest("hex")
      frozen.push({
        ...change,
        snapshot: { content, contentHash },
      })
    } catch (error) {
      return {
        ok: false,
        changeId: change.changeId,
        reason: `cannot freeze ${change.changeId}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { ok: true, frozen }
}
