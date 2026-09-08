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
 * orchestrator instead of being inferred from which renderer is waiting.
 */
export type CloseSquashPhase = "composing-message" | "awaiting-message-review" | "creating-commit"

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
