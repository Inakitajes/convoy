/**
 * Owned OpenCode server launches (change `fix-opencode-server-lifecycle`,
 * design D1/D2).
 *
 * The pinned SDK's server factory returns only `{ url, close() }`: it cannot
 * prove the child exited and it exposes no process handle. Convoy therefore
 * spawns the `serve` child itself, keeps the `node:child_process` handle, and
 * wraps the SDK client around the parsed URL. Ownership spans the entire
 * interval from spawn to confirmed exit, including helper callers that never
 * run a coordinator.
 *
 * Lifetime classes are explicit: only `run` and `helper` launches publish a
 * record eligible for orphan reconciliation. An `authoring-service` launch is
 * independently persistent — the borrower has no shutdown right and Convoy's
 * creator-death policy must never reap it.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"

import {
  captureIdentity,
  defaultIdentityProbe,
  type IdentityProbe,
  type LifetimeClass,
  type ProcessIdentity,
} from "./process-identity"
import { childStopTarget, stopTarget, type StopOutcome, type StopPolicy } from "./process-stop"
import {
  createProcessRecordStore,
  newProcessRecord,
  publishChildIdentity,
  reconcileProcessRecords,
  type ProcessRecord,
  type ProcessRecordStore,
} from "./process-records"

export type ManagedServer = {
  url: string
  pid: number
  /** Recorded child incarnation when the platform could observe one. */
  identity?: ProcessIdentity
  /** The durable record id when one was published (run/helper only). */
  recordId?: string
  /**
   * Idempotent bounded stop. Concurrent/repeated callers share one outcome.
   * A delivered signal is never reported as a confirmed stop.
   */
  stop(): Promise<StopOutcome>
  /**
   * Last-resort synchronous edge for a repeated abort or the shutdown
   * deadline: delivers SIGKILL immediately and starts the same observed stop,
   * so a coordinator can exit on a bounded timer instead of abandoning the
   * child. Safe to call repeatedly and after `stop()`.
   */
  forceStop(): void
}

export type SpawnChildFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export type ManagedServerOptions = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  lifetime: LifetimeClass
  /** Human label for diagnostics (e.g. "run server", "model catalog helper"). */
  label: string
  /** Readiness timeout; the SDK used 30s. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Readiness line parser; returns the URL or undefined for a non-readiness line. */
  parseLine?: (line: string) => { url: string } | "malformed" | undefined
  /** Recorded in the lifetime record so an orphan can be tied back to its run. */
  runId?: string
  deps?: {
    spawn?: SpawnChildFn
    probe?: IdentityProbe
    store?: ProcessRecordStore
    now?: () => number
    /**
     * Stop policy for this child. A resolver is evaluated at stop time so an
     * owned helper can draw from a shared, shrinking shutdown budget (design
     * D2) instead of starting a fresh standalone allowance.
     */
    policy?: StopPolicy | (() => StopPolicy)
    /**
     * Bounded orphan-recovery pass run before a run/helper boot (design D5).
     * Injectable so tests assert the wiring without touching real processes;
     * defaults to {@link reconcileProcessRecords}.
     */
    reconcile?: (deps: { store: ProcessRecordStore; probe: IdentityProbe }) => Promise<unknown>
  }
}

export const defaultReadinessTimeoutMs = 30_000

/**
 * Strict readiness parser matching the CLI's own line (`opencode server
 * listening on http://…`). A listening line without a parseable URL is
 * malformed and fails the boot rather than being ignored.
 */
export function parseReadinessLine(line: string): { url: string } | "malformed" | undefined {
  if (!line.startsWith("opencode server listening")) return undefined
  const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
  if (!match?.[1]) return "malformed"
  return { url: match[1] }
}

/** Bounds diagnostic stdout/stderr retained for error messages. */
const diagnosticTailLimit = 4_000

/**
 * Bounds the unterminated stdout line retained while waiting for a newline. A
 * readiness line is short, so a chatty child that never emits a newline cannot
 * grow the line buffer without bound; only the tail can still complete a line.
 */
const stdoutLineLimit = 64 * 1024

export class ManagedServerStartupError extends Error {
  readonly cleanup?: StopOutcome
  constructor(message: string, cleanup?: StopOutcome) {
    super(message)
    this.name = "ManagedServerStartupError"
    if (cleanup) this.cleanup = cleanup
  }
}

/**
 * Spawns and owns one `opencode serve` child. Resolves only once the child has
 * reported readiness *and* its ownership record has been published; rejects
 * (after bounded cleanup) for spawn errors, early exit, malformed readiness,
 * timeout, abort, or record-publication failure.
 */
export async function launchManagedServer(options: ManagedServerOptions): Promise<ManagedServer> {
  const deps = options.deps ?? {}
  const spawnChild = deps.spawn ?? (nodeSpawn as unknown as SpawnChildFn)
  const probe = deps.probe ?? defaultIdentityProbe()
  const store = deps.store ?? createProcessRecordStore()
  const now = deps.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? defaultReadinessTimeoutMs
  const reconciledLifetime = options.lifetime === "authoring-service" ? undefined : options.lifetime

  if (options.signal?.aborted) {
    throw new ManagedServerStartupError(`${options.label} was cancelled before it started`)
  }

  // Bounded orphan recovery before an owned run/helper boot (design D5): a
  // later managed launch is the only trigger that reclaims attributable
  // run/helper orphans left by an uncatchably-killed owner. It is bounded,
  // never signals a live owner's child, and never fails this launch — a
  // recovery pass that cannot classify an old record is not a reason to
  // refuse unrelated work.
  if (reconciledLifetime) {
    await (deps.reconcile ?? reconcileProcessRecords)({ store, probe }).catch(() => {})
  }

  // Provisional record before spawn (design D5): a crash between OS spawn and
  // identity publication must still leave evidence that a child may exist.
  let record: ProcessRecord | undefined
  if (reconciledLifetime) {
    const owner = await captureIdentity(process.pid, probe).catch(() => undefined)
    record = {
      ...newProcessRecord({ lifetime: reconciledLifetime, now: now() }),
      ...(owner ? { owner } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    }
    try {
      await store.put(record)
    } catch (error) {
      // Ownership evidence that cannot be persisted must not be papered over:
      // refuse to launch rather than create an unattributable child.
      throw new ManagedServerStartupError(
        `${options.label} ownership cannot be persisted under ${store.dir}: ${describe(error)}`,
      )
    }
  }

  const child = spawnChild(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  return await new Promise<ManagedServer>((resolve, reject) => {
    let settled = false
    let ready = false
    let stdoutBuffer = ""
    let stderrTail = ""
    let stdoutTail = ""
    let childIdentity: ProcessIdentity | undefined
    let stopPromise: Promise<StopOutcome> | undefined
    let abortListener: (() => void) | undefined
    let readinessTimer: ReturnType<typeof setTimeout> | undefined

    const cleanupListeners = () => {
      if (readinessTimer) clearTimeout(readinessTimer)
      child.removeListener?.("exit", onExit as never)
      if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener)
    }

    const performStop = (): Promise<StopOutcome> => {
      stopPromise ??= (async () => {
        const pid = child.pid ?? 0
        const target = childStopTarget({
          child,
          pid,
          ...(childIdentity
            ? {
                verify: async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
                  const observed = await probe.observe(pid)
                  if (observed.status === "gone") return { ok: true }
                  if (observed.status !== "alive") return { ok: false, reason: `child identity became ${observed.status}` }
                  return observed.identity.birth === childIdentity!.birth
                    ? { ok: true }
                    : { ok: false, reason: "child incarnation changed before escalation" }
                },
              }
            : {}),
        })
        const policy = typeof deps.policy === "function" ? deps.policy() : deps.policy
        const outcome = await stopTarget(target, policy)
        destroyPipes()
        // Release the record only on a confirmed stop; an unresolved child
        // keeps its evidence for a later reconciliation pass.
        if (record) {
          if (outcome.status === "stopped") await store.remove(record.id).catch(() => {})
          else await store.put({ ...record, state: "unresolved", updatedAt: now(), lastOutcome: outcome.reason }).catch(() => {})
        }
        return outcome
      })()
      return stopPromise
    }

    const destroyPipes = () => {
      try {
        child.stdout?.destroy?.()
      } catch {
        /* best effort */
      }
      try {
        child.stderr?.destroy?.()
      } catch {
        /* best effort */
      }
    }

    const forceStop = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* the child may already be gone; the stop state machine rechecks */
      }
      void performStop()
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      cleanupListeners()
      if (record && reconciledLifetime) {
        // The child exited before readiness; its record is resolved.
        void store.remove(record.id).catch(() => {})
      }
      reject(
        new ManagedServerStartupError(
          `${options.label} exited before it was ready (code ${code ?? "null"}${signal ? `, ${signal}` : ""})${diagnosticSuffix()}`,
        ),
      )
    }

    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanupListeners()
      if (record && reconciledLifetime) void store.remove(record.id).catch(() => {})
      reject(new ManagedServerStartupError(`${options.label} could not start: ${describe(error)}`))
    }

    const diagnosticSuffix = () => {
      const tail = (stderrTail || stdoutTail).trim()
      return tail ? `: ${tail.slice(-diagnosticTailLimit)}` : ""
    }

    const finish = () => {
      if (settled) return
      settled = true
      ready = true
      cleanupListeners()
      resolve({
        url: parsedUrl!,
        pid: child.pid ?? 0,
        ...(childIdentity ? { identity: childIdentity } : {}),
        ...(record ? { recordId: record.id } : {}),
        stop: performStop,
        forceStop,
      })
    }

    let parsedUrl: string | undefined

    const onLine = (line: string) => {
      if (settled || parsedUrl) return
      const parsed = (options.parseLine ?? parseReadinessLine)(line)
      if (!parsed) return
      if (parsed === "malformed") {
        settled = true
        cleanupListeners()
        void performStop().then((cleanup) => {
          reject(new ManagedServerStartupError(`${options.label} reported a malformed readiness line: ${line.trim()}`, cleanup))
        })
        return
      }
      parsedUrl = parsed.url
      // Publish child identity and readiness before exposing the URL.
      void publishOwnershipThenResolve()
    }

    const publishOwnershipThenResolve = async () => {
      if (settled) return
      childIdentity = await captureIdentity(child.pid ?? 0, probe).catch(() => undefined)
      if (record && reconciledLifetime) {
        if (!childIdentity) {
          // A run/helper whose required ownership evidence cannot be captured
          // must never be exposed as ready (design D1/D5): refuse readiness and
          // clean up through the owned child handle instead of leaking an
          // unattributable server.
          settled = true
          cleanupListeners()
          const cleanup = await performStop()
          reject(new ManagedServerStartupError(`${options.label} child identity could not be captured under ${store.dir}`, cleanup))
          return
        }
        const published = await publishChildIdentity(store, record, child.pid ?? 0, probe).catch(() => undefined)
        if (!published) {
          // Persisting ownership failed: refuse readiness and clean up. Settle
          // before the stop so the child's own exit cannot win the rejection
          // race and mask the ownership failure.
          settled = true
          cleanupListeners()
          const cleanup = await performStop()
          reject(new ManagedServerStartupError(`${options.label} ownership could not be published under ${store.dir}`, cleanup))
          return
        }
        record = published.record
        record = { ...record, state: "ready", url: parsedUrl, updatedAt: now() }
        // Awaited so a stop immediately after readiness cannot be overtaken by
        // this write and lose the unresolved outcome.
        await store.put(record).catch(() => {})
      }
      finish()
    }

    const onStdout = (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdoutBuffer += text
      stdoutTail = (stdoutTail + text).slice(-diagnosticTailLimit)
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n")
        if (newline === -1) break
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        onLine(line)
      }
      // Bound the partial line a newline-less child can accumulate before its
      // next newline arrives (only the tail can still complete a readiness
      // line), so stdout cannot grow without bound.
      if (stdoutBuffer.length > stdoutLineLimit) stdoutBuffer = stdoutBuffer.slice(-stdoutLineLimit)
    }

    const onStderr = (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-diagnosticTailLimit)
    }

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.once("exit", onExit as never)
    child.on("error", onError as never)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanupListeners()
      void performStop().then((cleanup) => {
        reject(new ManagedServerStartupError(`${options.label} did not report a readiness URL within ${timeoutMs}ms${diagnosticSuffix()}`, cleanup))
      })
    }, timeoutMs)
    timer.unref?.()
    readinessTimer = timer

    if (options.signal) {
      abortListener = () => {
        if (settled) return
        settled = true
        cleanupListeners()
        void performStop().then((cleanup) => {
          reject(new ManagedServerStartupError(`${options.label} was cancelled before it was ready`, cleanup))
        })
      }
      // A signal that fired during the async gaps before this listener existed
      // (reconciliation, owner capture, provisional publication) never replays
      // its event. Check `aborted` explicitly so a cancellation race can never
      // resolve a live owned server (design D1).
      if (options.signal.aborted) abortListener()
      else options.signal.addEventListener("abort", abortListener, { once: true })
    }

    // A child that never emits a readiness line but exits cleanly is handled
    // by onExit; one whose stdout closes early is handled by the timeout.
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
