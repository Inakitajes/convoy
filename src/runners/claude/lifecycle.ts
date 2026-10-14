/**
 * Claude attempt lifecycle: interruption deadlines, view/execution separation,
 * and the finished-run controller lease (change `runner-parity-opencode-v2`,
 * tasks 5.4/5.5; design D11).
 *
 * Three lifetimes must not be conflated:
 *
 * - **Execution**: an attempt cancels exactly once, on explicit stop, within a
 *   shared deadline that then escalates.
 * - **View**: a dashboard detaching is not a cancellation and does not release
 *   writer authority or pending decisions.
 * - **Controller hold**: a finished run follows the existing 15s lease plus the
 *   1s detection allowance, and a replacement controller can never be released
 *   by the previous holder's stale calls.
 *
 * Nothing here signals a process; it decides *what* to do, and the owned-process
 * utilities in `./process` perform the bounded, identity-checked cleanup.
 */

/** The existing coordinator lease duration (control-server `controllerTimeoutMs`). */
export const controllerLeaseHeartbeatMs = 15_000
/** The tick that observes a silent controller's expiry. */
export const controllerLeaseDetectionMs = 1_000
/** Worst-case time from last heartbeat to a detected expiry. */
export const controllerLeaseDeadlineMs = controllerLeaseHeartbeatMs + controllerLeaseDetectionMs

export class AttemptCancelledError extends Error {
  constructor(message = "attempt cancelled") {
    super(message)
    this.name = "AttemptCancelledError"
  }
}

export type AttemptLifecycle = {
  abort: AbortSignal
  aborted: boolean
  /** Requests cancellation. Idempotent: only the first call aborts and notifies. */
  cancel(): void
}

export type AttemptLifecycleOptions = {
  /**
   * Notified when cancellation is requested. With a `deadlineMs`, a second call
   * signals that the shared interrupt budget expired and cleanup must escalate.
   */
  onCancel?: () => void
  /**
   * Shared bounded interrupt deadline. When it elapses after `cancel()`, the
   * callback is invoked a second time so the owner can force cleanup instead of
   * waiting forever on an unresponsive child.
   */
  deadlineMs?: number
}

/**
 * Creates the cancellation source for one attempt. Repeated `cancel()` shares
 * the first result; an optional deadline escalates once if cleanup has not
 * settled in time.
 */
export function createAttemptLifecycle(options: AttemptLifecycleOptions = {}): AttemptLifecycle {
  const controller = new AbortController()
  let cancelled = false
  let escalated = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined

  const cancel = () => {
    if (cancelled) return
    cancelled = true
    controller.abort(new AttemptCancelledError())
    options.onCancel?.()
    if (options.deadlineMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        if (escalated) return
        escalated = true
        options.onCancel?.()
      }, options.deadlineMs)
      deadlineTimer.unref?.()
    }
  }

  return {
    get abort() {
      return controller.signal
    },
    get aborted() {
      return controller.signal.aborted
    },
    cancel,
  }
}

/** A client view (dashboard attachment) owns a controller identity when attached. */
export type ViewAttachment = { controller?: string }

/** True when an attachment currently holds the controller role. */
export function controllerHeld(attachment: ViewAttachment): boolean {
  return Boolean(attachment.controller)
}

export type ReleaseSignals = {
  /** A dashboard/client view detached. */
  viewDetached?: boolean
  /** The operator explicitly stopped the selected work. */
  explicitStop?: boolean
  /** A controller still holds the finished-run slot. */
  controllerHeld?: boolean
}

export type ReleaseDecision = {
  /** Whether the selected execution should be cancelled. */
  cancelExecution: boolean
  /** Whether owned view/hold resources should be released. */
  releaseResources: boolean
  reason: string
}

/**
 * Separates view detachment from execution cancellation (design D11):
 *
 * - only an explicit stop cancels execution;
 * - a view detach never cancels execution, pending decisions, or writer claims;
 * - a finished-run hold releases on controller absence, but even then does not
 *   cancel execution, so an independent authoring session survives run cleanup.
 */
export function separateRelease(signals: ReleaseSignals): ReleaseDecision {
  if (signals.explicitStop) {
    return {
      cancelExecution: true,
      releaseResources: true,
      reason: "explicit stop cancels the selected work before releasing owned resources",
    }
  }

  if (signals.viewDetached) {
    if (signals.controllerHeld) {
      return {
        cancelExecution: false,
        releaseResources: false,
        reason: "view detached while a controller is held; execution and decisions continue for reattachment",
      }
    }
    return {
      cancelExecution: false,
      releaseResources: true,
      reason: "view detached with no controller; release the finished-run hold without stopping execution or independent authoring",
    }
  }

  return { cancelExecution: false, releaseResources: false, reason: "no release requested" }
}

/**
 * The claim-scoped controller slot shared with the control server. A caller only
 * affects the slot it still owns: a stale heartbeat does not keep a replacement
 * alive, and a stale release cannot evict it.
 */
export class ControllerLease {
  private controller: string | undefined
  private lastSeen = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Claims the slot for `controller` (a claim replaces any previous holder). */
  acquire(controller: string): void {
    this.controller = controller
    this.lastSeen = this.now()
  }

  /** Refreshes the lease for its holder; `false` for a stale/replaced controller. */
  heartbeat(controller: string): boolean {
    if (!this.holds(controller)) return false
    this.lastSeen = this.now()
    return true
  }

  /** True when the whole lease has been silent past the heartbeat window. */
  isExpired(now: number): boolean {
    if (this.controller === undefined) return false
    return now - this.lastSeen >= controllerLeaseHeartbeatMs
  }

  /** Releases the slot; `false` when `controller` is stale or already gone. */
  release(controller: string): boolean {
    if (this.controller === undefined || controller !== this.controller) return false
    this.controller = undefined
    this.lastSeen = 0
    return true
  }

  /** Whether `controller` currently owns the slot. */
  holds(controller: string): boolean {
    return this.controller !== undefined && this.controller === controller
  }

  /** The current holder, if any. */
  current(): string | undefined {
    return this.controller
  }
}
