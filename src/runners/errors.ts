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
