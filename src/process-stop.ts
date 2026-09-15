/**
 * Bounded process-stop state machine shared by owned children and orphan
 * reconciliation (change `fix-opencode-server-lifecycle`, design D2/D5).
 *
 * A delivered signal is never a confirmed stop. Every stop attempt observes
 * the outcome within a finite budget: graceful termination first, forced
 * escalation after the grace window, then a bounded observation window. The
 * state machine is idempotent — concurrent callers share one outcome — and it
 * never signals a target it cannot re-verify immediately before escalation.
 */

export type StopOutcome =
  | { status: "stopped"; via: "already-gone" | "graceful" | "forced" }
  | { status: "unresolved"; reason: string }

export type StopPolicy = {
  /** Graceful window after SIGTERM (default 2s). */
  graceMs?: number
  /** Observation window after SIGKILL (default 1s). */
  forceObservationMs?: number
  /** Poll interval for pid-observed targets (default 50ms). */
  pollMs?: number
}

export const defaultStopPolicy = { graceMs: 2_000, forceObservationMs: 1_000, pollMs: 50 } as const

export type StopTarget = {
  pid: number
  /** True once the target is known to have exited. */
  isExited(): boolean
  /** Resolves true when exit is observed within `timeoutMs`. */
  waitForExit(timeoutMs: number): Promise<boolean>
  /** Best-effort signal delivery. May throw; the caller rechecks exit after. */
  signal(signal: "SIGTERM" | "SIGKILL"): void
  /**
   * Revalidates that this is still the recorded incarnation. Called before
   * forced escalation; a false result abandons the escalation (never signal a
   * process that may have been replaced).
   */
  verify?(): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Records bounded diagnostic evidence when the outcome is unresolved. */
  onUnresolved?(reason: string): void
}

/**
 * Runs the bounded stop algorithm. Never throws: signal/probe failures become
 * an `unresolved` outcome with a bounded reason.
 */
export async function stopTarget(target: StopTarget, policy: StopPolicy = {}): Promise<StopOutcome> {
  const graceMs = policy.graceMs ?? defaultStopPolicy.graceMs
  const forceObservationMs = policy.forceObservationMs ?? defaultStopPolicy.forceObservationMs

  if (target.isExited()) return { status: "stopped", via: "already-gone" }

  // A signal error (ESRCH) is only meaningful after rechecking exit: if the
  // target is gone the stop succeeded, otherwise the failure is real.
  const alreadyGoneAfter = (): StopOutcome | undefined => (target.isExited() ? { status: "stopped", via: "already-gone" } : undefined)

  try {
    target.signal("SIGTERM")
  } catch (error) {
    const settled = alreadyGoneAfter()
    if (settled) return settled
    return unresolved(target, `could not deliver SIGTERM: ${describeError(error)}`)
  }

  if (await target.waitForExit(graceMs)) return { status: "stopped", via: "graceful" }
  if (target.isExited()) return { status: "stopped", via: "graceful" }

  if (target.verify) {
    const verified = await target.verify()
    if (!verified.ok) return unresolved(target, `refused forced escalation: ${verified.reason}`)
  }

  try {
    target.signal("SIGKILL")
  } catch (error) {
    const settled = alreadyGoneAfter()
    if (settled) return settled
    return unresolved(target, `could not deliver SIGKILL: ${describeError(error)}`)
  }

  if (await target.waitForExit(forceObservationMs)) return { status: "stopped", via: "forced" }
  if (target.isExited()) return { status: "stopped", via: "forced" }
  return unresolved(target, `termination was requested but exit was not observed within the shutdown budget`)
}

function unresolved(target: StopTarget, reason: string): StopOutcome {
  target.onUnresolved?.(reason)
  return { status: "unresolved", reason }
}

/**
 * A `StopTarget` for a `node:child_process` child Convoy owns: exit is
 * observed through the child API rather than by polling a PID.
 */
export function childStopTarget(options: {
  child: {
    pid?: number
    kill(signal?: NodeJS.Signals | number): boolean
    once(event: "exit", listener: () => void): unknown
    removeListener(event: "exit", listener: () => void): unknown
  }
  pid: number
  /** Optional re-verification hook before forced escalation. */
  verify?: StopTarget["verify"]
  onUnresolved?: (reason: string) => void
}): StopTarget {
  let exited = false
  const listeners = new Set<() => void>()
  const onExit = () => {
    exited = true
    for (const listener of [...listeners]) listener()
  }
  options.child.once("exit", onExit)
  return {
    pid: options.pid,
    isExited: () => exited,
    waitForExit: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        if (exited) {
          resolve(true)
          return
        }
        let settled = false
        const done = (value: boolean) => {
          if (settled) return
          settled = true
          listeners.delete(onExitListener)
          clearTimeout(timer)
          resolve(value)
        }
        const onExitListener = () => done(true)
        listeners.add(onExitListener)
        const timer = setTimeout(() => done(false), timeoutMs)
        timer.unref?.()
      }),
    signal: (signal) => {
      options.child.kill(signal)
    },
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.onUnresolved ? { onUnresolved: options.onUnresolved } : {}),
  }
}

/**
 * A `StopTarget` for a recorded PID observed through the injected probe — the
 * reconciliation path, where no child handle exists.
 */
export function observedStopTarget(options: {
  pid: number
  observe: () => Promise<"alive" | "gone" | "unknown">
  signal: (signal: "SIGTERM" | "SIGKILL") => void
  pollMs?: number
  verify?: StopTarget["verify"]
  onUnresolved?: (reason: string) => void
}): StopTarget {
  const pollMs = options.pollMs ?? defaultStopPolicy.pollMs
  let exited = false
  return {
    pid: options.pid,
    isExited: () => exited,
    waitForExit: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const observation = await options.observe()
        if (observation === "gone") {
          exited = true
          return true
        }
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
      }
    },
    signal: options.signal,
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.onUnresolved ? { onUnresolved: options.onUnresolved } : {}),
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
