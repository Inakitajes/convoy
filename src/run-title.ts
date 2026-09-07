import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { firstMeaningfulLine, stripControlBytes } from "./commit-text"
import { branchIdFromBranch, isOpenSpecChangeId, openspecDirName, titleFromProposal } from "./openspec"

/**
 * One dependency-light title-resolution module for every human title a run
 * carries (capability run-titles, design D1/D3): the runs-browser row, the
 * cleanup-surviving history entry, and the metadata field persisted at run
 * start all resolve through the same precedence —
 *
 *   change proposal title → humanized branch slug → prompt's first line
 *
 * so a run launched from a spec pointer is never titled by the pointer
 * prompt's first line. The module imports nothing heavier than
 * `commit-text.ts`-level helpers plus the OpenSpec filesystem readers, does no
 * model calls, and owns no truncation: display caps (the 60-column runs list)
 * stay a consumer concern.
 */

/**
 * The conventional branch prefixes Convoy itself creates (the branch-naming
 * types plus spin's `change/<id>`, which is deliberately not a
 * conventional-commit type but is a real Convoy branch prefix). A leading
 * `<type>/` is dropped when humanizing and supplies the PR title's commit
 * type; anything else is an authored branch whose name is rendered as-is.
 */
const branchPrefixTypes = new Set(["feat", "change", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"])

/**
 * The branch slug rendered as words: the conventional `type/` prefix dropped,
 * separators rendered as spaces, control bytes stripped. `feat/quiet-notifications`
 * → `quiet notifications`; `change/y` → `y`; a bare `widget` → `widget`.
 */
export function humanizeBranchSlug(branch: string | undefined): string {
  if (!branch) return ""
  const cleaned = stripControlBytes(branch.trim())
  if (!cleaned) return ""
  const slash = cleaned.indexOf("/")
  const head = slash === -1 ? "" : cleaned.slice(0, slash).trim().toLowerCase()
  const body = branchPrefixTypes.has(head) ? cleaned.slice(slash + 1) : cleaned
  return body.replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim()
}

/** The conventional commit type a branch's prefix supplies, or none — never a fabricated one. */
export function conventionalTypeFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined
  const slash = branch.indexOf("/")
  if (slash <= 0) return undefined
  const head = branch.slice(0, slash).trim().toLowerCase()
  return branchPrefixTypes.has(head) ? head : undefined
}

/**
 * The precedence as a pure function: the change's proposal title first, then
 * the humanized branch slug, then the prompt's first meaningful line — the
 * prompt only ever firing for runs with no attached change and no feature
 * branch. Empty inputs collapse; `undefined` means no title could be resolved.
 */
export function resolveRunTitle(input: { changeTitle?: string; branch?: string; prompt?: string }): string | undefined {
  const changeTitle = stripControlBytes(input.changeTitle ?? "").trim()
  if (changeTitle) return changeTitle
  const slug = humanizeBranchSlug(input.branch)
  if (slug) return slug
  const promptLine = stripControlBytes(firstMeaningfulLine(input.prompt ?? "")).trim()
  return promptLine || undefined
}

/**
 * The change title the control board's reader produces for one change
 * directory: `titleFromProposal` over the change's `proposal.md`, falling back
 * to the id inside that reader. `undefined` when the change or proposal is
 * missing or unreadable — never an invented title.
 */
export async function readChangeTitle(targetDir: string, changeId: string): Promise<string | undefined> {
  if (!isOpenSpecChangeId(changeId)) return undefined
  try {
    const body = await readFile(join(targetDir, openspecDirName, "changes", changeId, "proposal.md"), "utf8")
    return titleFromProposal(body, changeId)
  } catch {
    return undefined
  }
}

/**
 * The change-title lookup the title precedence starts from: the shared
 * branch↔change rule (`branchIdFromBranch`) resolves the change id, the
 * proposal title is read against `targetDir` exactly as the control board
 * reads it. `undefined` when the branch carries no change id or the proposal
 * is absent/unreadable.
 */
export async function resolveChangeTitle(targetDir: string, branch: string | undefined): Promise<string | undefined> {
  const changeId = branchIdFromBranch(branch)
  if (!changeId) return undefined
  return readChangeTitle(targetDir, changeId)
}

/**
 * The full async resolution `openRunMetadata` performs once at run start:
 * change proposal → humanized branch slug → prompt first line, with every
 * filesystem read optional so an absent source degrades to the next one.
 */
export async function resolveRunTitleFor(input: { targetDir: string; branch?: string; prompt?: string }): Promise<string | undefined> {
  const changeTitle = await resolveChangeTitle(input.targetDir, input.branch)
  return resolveRunTitle({ changeTitle, branch: input.branch, prompt: input.prompt })
}

/**
 * The title persisted in a run's `metadata.json`, read tolerantly: `undefined`
 * for missing/corrupt records and legacy records without the field, so
 * discovery falls back without rewriting anything.
 */
export async function readPersistedRunTitle(runDir: string | undefined): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  try {
    const parsed = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as { title?: unknown }
    if (typeof parsed.title !== "string") return undefined
    const title = parsed.title.trim()
    return title || undefined
  } catch {
    return undefined
  }
}
