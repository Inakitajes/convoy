/**
 * The shared close narration types (change `worktree-control-center`, task
 * 8.4): extracted from the retired feature-close module so the close
 * composite (worktree-commands), the checklist renderer (close-presentation),
 * and the interactive checklist (close-tui) keep one event vocabulary without
 * importing the retired feature domain.
 */

/** The close composite's steps, in execution order. */
export type CloseStep = "sync" | "archive" | "squash-merge"

/**
 * The squash-merge step's typed sub-states (design D8): stable identifiers the
 * renderers map to their own copy, so semantic operation state stays in the
 * orchestrator instead of being inferred from which renderer is waiting. The
 * hosted sub-phases narrate the remote landing steps (change
 * `close-lands-via-github-pr`): publishing the branch, requesting GitHub's
 * squash-merge, and advancing the local base to the hosted commit.
 */
export type CloseSquashPhase =
  | "composing-message"
  | "awaiting-message-review"
  | "creating-commit"
  | "pushing-branch"
  | "requesting-merge"
  | "catching-up-base"

/**
 * The landing decision the interactive message gate can carry when a linked
 * open PR offers the hosted path (change `close-lands-via-github-pr`, design
 * D5): accept the reviewed message and land through GitHub, decline and land
 * locally with the same reviewed message, or cancel the close. A plain
 * message gate (no linked PR) never offers the hosted choice.
 */
export type CloseLandingDecision =
  | { kind: "hosted"; message: string }
  | { kind: "local"; message: string }
  | { kind: "cancel" }

/**
 * The observed facts of a hosted landing (change `close-lands-via-github-pr`):
 * stated only after they were observed, never claimed in advance.
 */
export type HostedMergeFacts = {
  prNumber: number
  /** GitHub's squash commit, when the hosting evidence resolved it. */
  mergeSha?: string
  base: string
  /** Whether the local base was fast-forwarded (false = it already contained the hosted commit). */
  baseAdvanced: boolean
}

/** How the close ended, stated once (design D8: no dual merge-shape narration). */
export type CloseDisposition =
  /** The base advanced onto the one candidate commit. */
  | "landed"
  /** The source's post-archive tree equals the captured base tree — nothing to land, no empty commit. */
  | "no-content-to-land"
  /** A verified receipt shows this exact feature already landed; nothing was redone. */
  | "already-landed"

/** A preflight blocker with its check name, for the checklist and headless output. */
export type ClosePreflightBlocker = {
  check: "clean-tree" | "tasks" | "live-run" | "main-checkout" | "unrelated-base"
  message: string
}

/** The close composite's outcome, stated once for every entry point. */
export type CloseResult = {
  changeID: string
  branch: string
  worktreeDir: string
  baseRef: string
  disposition: CloseDisposition
  /** Present when the disposition is "landed" or "already-landed". */
  landing?: { sha: string }
  /**
   * The open pull request this attempt detected for the source branch,
   * present only when a landing happened this attempt. Never asserts merge
   * state.
   */
  pullRequest?: DetectedPullRequest
}

/** An open pull request detected for the source branch: the probe's whole truth. */
export type DetectedPullRequest = {
  number: number
  title?: string
  url: string
}

/** One-way narration of the close sequence (design D8). */
export type CloseEvent =
  | { type: "preflight"; summary: string }
  | { type: "preflight-failed"; blockers: readonly ClosePreflightBlocker[] }
  | { type: "step-started"; step: CloseStep }
  | { type: "step-completed"; step: CloseStep; detail?: string }
  | { type: "step-skipped"; step: CloseStep; reason: string }
  | { type: "step-failed"; step: CloseStep; message: string }
  | { type: "squash-phase"; phase: CloseSquashPhase }
  | { type: "result"; result: CloseResult }

/** What the message gate hands the operator: the normalized proposal, and where it came from. */
export type CloseMessageProposal = {
  message: string
  source: "model" | "fallback"
  /** Set when the writing model failed and the message is the deterministic fallback. */
  error?: string
}
