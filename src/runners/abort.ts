/**
 * The user-abort signal shared by the engine, the adapters and the process
 * entrypoints (moved out of the engine by change `unify-runner-system`, task
 * 2.1 so an adapter never imports `runner.ts`).
 */

export class UserAbortError extends Error {
  constructor(message = "aborted by user") {
    super(message)
    this.name = "UserAbortError"
  }
}

export function isUserAbortError(error: unknown): error is UserAbortError {
  return error instanceof UserAbortError || (error instanceof Error && error.name === "UserAbortError")
}
