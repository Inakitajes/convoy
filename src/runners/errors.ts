/**
 * Best-effort message extraction from a vendor or SDK error shape (moved out
 * of the engine by change `unify-runner-system`, task 2.1).
 */

export function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data && "message" in data) return String((data as { message?: unknown }).message)
  }
  if (typeof error === "object" && error && "name" in error) return String((error as { name?: unknown }).name)
  return String(error)
}

/**
 * The turn cannot fit the model's context window: OpenCode's automatic
 * compaction ran out of earlier history to summarize. Retrying the same prompt
 * fails the same way, so the engine retries once with attachments by path.
 */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContextOverflowError"
  }
}

/** Matches the overflow directly or as the cause of an engine wrapper error. */
export function isContextOverflowError(error: unknown): boolean {
  return error instanceof ContextOverflowError || (error instanceof Error && error.cause instanceof ContextOverflowError)
}
