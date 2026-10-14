/**
 * Owned Claude child-process adoption (change `runner-parity-opencode-v2`, task 5.3).
 *
 * A Claude attempt owns real child processes (the CLI, and later its local
 * bridges). This module adopts a spawned child into the same ownership
 * vocabulary the OpenCode server uses — a bounded, observed, idempotent stop
 * state machine from `src/process-stop.ts` — so cancellation and orphan
 * reconciliation never signal a process whose identity cannot be re-verified.
 *
 * It deliberately re-uses the shared stop machinery rather than reimplementing
 * the escalation budget: a delivered signal is never a confirmed stop, and
 * forced escalation is refused when the identity check fails. A PID or process
 * name alone never authorizes termination (design D11).
 */

import { childStopTarget, stopTarget, type StopOutcome, type StopPolicy } from "../../process-stop"

export type OwnedProcess = {
  pid: number
  /** True once exit has been observed through the child handle. */
  isExited(): boolean
  /** Idempotent bounded stop; concurrent callers share one observed outcome. */
  stop(): Promise<StopOutcome>
  /** Last-resort synchronous SIGKILL edge for a shutdown that cannot wait. */
  forceStop(): void
}

export type AdoptableChild = {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: "exit", listener: () => void): unknown
  removeListener(event: "exit", listener: () => void): unknown
}

export type AdoptChildOptions = {
  /** Bounded stop budget; defaults come from `defaultStopPolicy`. */
  policy?: StopPolicy
  /**
   * Re-verifies that the child is still the executable Convoy spawned before any
   * forced escalation. A reused PID or incomplete evidence must answer
   * `{ ok: false }` so the process is never force-killed as somebody else's.
   */
  verifyExpectedExecutable?: () => Promise<{ ok: boolean; reason?: string }>
}

/**
 * Adopts a spawned child as an owned process. Exit is observed through the child
 * handle (never by polling a bare PID), and the returned `stop` shares one
 * in-flight outcome across concurrent callers.
 */
export function adoptChild(child: AdoptableChild, options: AdoptChildOptions = {}): OwnedProcess {
  const target = childStopTarget({
    child: child as unknown as Parameters<typeof childStopTarget>[0]["child"],
    pid: child.pid ?? 0,
    ...(options.verifyExpectedExecutable ? { verify: verifyHook(options.verifyExpectedExecutable) } : {}),
  })

  let stopPromise: Promise<StopOutcome> | undefined
  // `policy` is optional so a registry can supply its shared budget at the first
  // call; the shared promise means the first caller's budget wins.
  const stop = (policy?: StopPolicy): Promise<StopOutcome> => (stopPromise ??= stopTarget(target, policy ?? options.policy))
  const forceStop = () => {
    try {
      if (child.pid) child.kill("SIGKILL")
    } catch {
      // Best effort: the observed stop path records the real outcome.
    }
  }

  return { pid: child.pid ?? 0, isExited: () => target.isExited(), stop, forceStop }
}

/**
 * Adapts the caller's verification hook to the stop machine's contract. A hook
 * that throws is treated as *unverifiable identity*, not as a passing check, so
 * a probe failure can never license a forced kill.
 */
function verifyHook(hook: () => Promise<{ ok: boolean; reason?: string }>): () => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async () => {
    try {
      const result = await hook()
      if (result.ok) return { ok: true }
      return { ok: false, reason: result.reason ?? "process identity could not be re-verified" }
    } catch (error) {
      return { ok: false, reason: `identity verification failed: ${describeError(error)}` }
    }
  }
}

export type RegistryStopResult = {
  /** Processes whose stop was observed, with the mechanism that settled it. */
  stopped: { id: string; via: "already-gone" | "graceful" | "forced" }[]
  /** Processes whose termination could not be observed; evidence is retained. */
  unresolved: { id: string; reason: string }[]
}

export type ProcessRegistry = {
  register(id: string, process: OwnedProcess): void
  /** Forgets a process and any retained unresolved evidence for it. */
  release(id: string): void
  /** Stops every registered process concurrently with one shared budget. */
  stopAll(policy?: StopPolicy): Promise<RegistryStopResult>
  /** Retained unresolved evidence for processes still registered. */
  unresolved(): { id: string; reason: string }[]
}

/** A resource the registry can stop; `OwnedProcess.stop` satisfies the optional policy. */
type Stoppable = { stop(policy?: StopPolicy): Promise<StopOutcome> }

/**
 * Tracks owned processes for one coordinator scope. A confirmed stop ends Convoy
 * ownership of that process; an unresolved stop keeps the id and its reason so
 * reconciliation can preserve the evidence instead of silently forgetting it.
 */
export function createProcessRegistry(): ProcessRegistry {
  const processes = new Map<string, Stoppable>()
  const failures = new Map<string, string>()

  return {
    register(id, process) {
      processes.set(id, process)
      failures.delete(id)
    },
    release(id) {
      processes.delete(id)
      failures.delete(id)
    },
    async stopAll(policy) {
      const entries = [...processes.entries()]
      const stopped: RegistryStopResult["stopped"] = []
      const unresolved: RegistryStopResult["unresolved"] = []
      await Promise.all(
        entries.map(async ([id, process]) => {
          let outcome: StopOutcome
          try {
            outcome = await process.stop(policy)
          } catch (error) {
            outcome = { status: "unresolved", reason: describeError(error) }
          }
          if (outcome.status === "stopped") {
            processes.delete(id)
            failures.delete(id)
            stopped.push({ id, via: outcome.via })
          } else {
            failures.set(id, outcome.reason)
            unresolved.push({ id, reason: outcome.reason })
          }
        }),
      )
      return { stopped, unresolved }
    },
    unresolved() {
      return [...failures.entries()].map(([id, reason]) => ({ id, reason }))
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
