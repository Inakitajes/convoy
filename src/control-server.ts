import { createServer } from "node:net"

import { log } from "./log"
import type {
  AutoAccept,
  AutoAcceptMode,
  GoalLoopView,
  HumanReviewAction,
  HumanReviewPromptInfo,
  PermissionPromptInfo,
  PermissionReply,
  ProgressPhase,
  RunControlState,
  RunFinalizationView,
} from "./progress"
import type { Pipeline } from "./types"

/**
 * The loopback control plane the run coordinator serves and an attached
 * dashboard talks to. Same house style as the report/advisor bridges
 * (`Bun.serve({ hostname: "127.0.0.1", idleTimeout: 0 })` + `Authorization:
 * Bearer <uuid>`), but a deliberately separate server: no shared tokens, no
 * shared paths.
 *
 * The protocol server is decoupled from the runner so it can be unit-tested
 * with a fake RunControl / shutdown / AutoAccept. `ControlProgress` wires the
 * real coordinator objects into `ControlServerHandlers` and drives the pending
 * gate queue.
 */

export type ControlRole = "controller" | "observer"

/** Serializable shape of a waiting permission prompt, as GET /pending returns it. */
export type PendingPermissionView = {
  requestId: string
  permission: string
  patterns: string[]
  command?: string
  target?: string
  description?: string
  sessionID?: string
  judgeReason?: string
}

/** Serializable shape of a waiting human gate, as GET /pending returns it. */
export type PendingHumanView = {
  requestId: string
  stepName: string
  iterations: number
  kind?: "interactive" | "failure" | "budget-gate"
  error?: string
  canRetry?: boolean
}

/**
 * Hosted-run `resetPipeline` payload: the runner repoints the dashboard at the
 * run's phases and identity once (a goal cycle is one logical run), and the
 * same payload travels to an attaching client so it rebuilds identically.
 * Everything here is plain JSON data (ProgressPhase and Pipeline are data-only
 * types). `goalLoop` carries the goal cycle's live view (scores so far,
 * iteration counter) so the client's header keeps the trajectory the
 * in-process dashboard sees.
 */
export type ControlReset = {
  runID: string
  targetDir: string
  runDir: string
  pipelineName: string
  phases: ProgressPhase[]
  pipeline: Pipeline
  retainMessage?: string
  goalLoop?: GoalLoopView
}

/** Serializable shape of a waiting finish hold, as GET /pending returns it. */
export type PendingFinishView = {
  status: "completed" | "failed"
  error?: string
  goalLoop?: GoalLoopView
  /** The run-finalization outcome, transported so attached dashboards show it (design D8). */
  finalization?: RunFinalizationView
}

export type PendingSnapshot = {
  permission?: PendingPermissionView
  human?: PendingHumanView
  finish?: PendingFinishView
  reset?: ControlReset
}

/**
 * The gate waits the coordinator forwards to the control plane. The attached
 * dashboard polls GET /pending, renders the prompt, and resolves it with the
 * matching POST; the queue's promise is what the coordinator's progress
 * adapter (or, in a test) awaits.
 *
 * A gate with no controller stays pending: the queue never rejects on its own,
 * so a controller that dies and is replaced by `convoy runs` finds the prompt
 * still answered.
 *
 * Permissions and human gates are queues, not single slots: parallel phases
 * can ask concurrently, and overwriting a waiter would orphan its promise
 * (the coordinator would block on it forever). The snapshot surfaces the head
 * of each queue — one modal at a time, the same semantics the TUI dashboard
 * gives an in-process owner.
 */
export class ControlPendingQueue {
  private permissions: Array<{ info: PermissionPromptInfo; resolve: (reply: PermissionReply) => void }> = []
  private humans: Array<{ id: string; info: HumanReviewPromptInfo; resolve: (action: HumanReviewAction) => void }> = []
  private finish?: { outcome: PendingFinishView; resolve: () => void }
  private reset?: ControlReset

  snapshot(): PendingSnapshot {
    const out: PendingSnapshot = {}
    const permission = this.permissions[0]
    if (permission) out.permission = permissionView(permission.info)
    const human = this.humans[0]
    if (human) out.human = humanView(human.info, human.id)
    if (this.finish) out.finish = this.finish.outcome
    if (this.reset) out.reset = this.reset
    return out
  }

  /** Waits until a controller answers this permission prompt. */
  holdPermission(info: PermissionPromptInfo): Promise<PermissionReply> {
    return new Promise<PermissionReply>((resolve) => {
      this.permissions.push({ info, resolve })
    })
  }

  /** Waits until a controller resolves this human gate. */
  holdHuman(info: HumanReviewPromptInfo): Promise<HumanReviewAction> {
    return new Promise<HumanReviewAction>((resolve) => {
      this.humans.push({ id: crypto.randomUUID(), info, resolve })
    })
  }

  /**
   * Waits until a controller dismisses the finish screen. The outcome travels
   * with the hold so the attached client renders the real finish screen
   * (status, error, goal-loop verdict) instead of guessing from metadata.
   */
  holdFinish(outcome: PendingFinishView): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finish = {
        outcome,
        resolve: () => {
          this.finish = undefined
          resolve()
        },
      }
    })
  }

  /** Replaces the current goal-loop reset; clients dedupe by runID. */
  pushReset(reset: ControlReset): void {
    this.reset = reset
  }

  resolvePermission(requestId: string, reply: PermissionReply): boolean {
    const index = this.permissions.findIndex((slot) => slot.info.id === requestId)
    if (index === -1) return false
    const [slot] = this.permissions.splice(index, 1)
    slot?.resolve(reply)
    return true
  }

  resolveHuman(requestId: string, action: HumanReviewAction): boolean {
    const index = this.humans.findIndex((slot) => slot.id === requestId)
    if (index === -1) return false
    const [slot] = this.humans.splice(index, 1)
    slot?.resolve(action)
    return true
  }

  resolveFinish(): boolean {
    const slot = this.finish
    if (!slot) return false
    slot.resolve()
    return true
  }
}

export function permissionView(info: PermissionPromptInfo): PendingPermissionView {
  return {
    requestId: info.id,
    permission: info.permission,
    patterns: info.patterns.slice(0, 5),
    ...(info.command ? { command: info.command } : {}),
    ...(info.target ? { target: info.target } : {}),
    ...(info.description ? { description: info.description } : {}),
    ...(info.sessionID ? { sessionID: info.sessionID } : {}),
    ...(info.judgeReason ? { judgeReason: info.judgeReason } : {}),
  }
}

export function humanView(h: HumanReviewPromptInfo, requestId: string): PendingHumanView {
  return {
    requestId,
    stepName: h.stepName,
    iterations: h.iterations,
    ...(h.kind ? { kind: h.kind } : {}),
    ...(h.error ? { error: h.error } : {}),
    ...(h.canRetry !== undefined ? { canRetry: h.canRetry } : {}),
  }
}

/**
 * The coordinator-side objects the control routes act on. Tests wire fakes;
 * ControlProgress wires the real RunControl, RunShutdown, Caffeinate, and AutoAccept.
 */
export type ControlServerHandlers = {
  /** `POST /pause` — `RunControl.toggle()` toward pause. */
  onPause?: () => void | Promise<void>
  /** `POST /resume` — `RunControl.resume()`. */
  onResume?: () => void | Promise<void>
  /** `POST /abort` — `shutdown.request("remote")`, same teardown as Ctrl+C. */
  onAbort?: () => void | Promise<void>
  /** `POST /keep-awake` — `Caffeinate.toggle()`. */
  onKeepAwakeToggle?: () => void | Promise<void>
  /** `POST /keep-run-dir` — an attached dashboard opened a session that still needs the run dir. */
  onKeepRunDirRequested?: () => void | Promise<void>
  /** `POST /finish-dismiss` — caller-side unblock of the finish hold. */
  onFinishDismiss?: () => void | Promise<void>
  /** When set, `POST /auto-accept` runs this instead of mutating `autoAccept`. */
  onAutoAccept?: (mode: AutoAcceptMode) => void | Promise<void>
  /** The shared AutoAccept object the server cycles when no `onAutoAccept` is set. */
  autoAccept?: AutoAccept
  /** Optional live status for GET /status; coordinator supplies run metadata. */
  statusProvider?: () => ControlStatus
}

export type ControlStatus = {
  runID?: string
  controlState?: RunControlState
  keepAwake?: "on" | "off" | "unavailable"
}

export type ControlServerOptions = {
  hostname?: string
  handlers?: ControlServerHandlers
  /** Gate waits. Defaults to a fresh queue when omitted. */
  pending?: ControlPendingQueue
  /**
   * How long the controller slot survives without a request carrying the
   * controller id. The controller client's /status poll (500 ms) is the
   * heartbeat; a client that dies without /bye (terminal closed, crash)
   * releases the slot after this window so the next `convoy runs` attach can
   * take control instead of being locked out as an observer forever.
   */
  controllerTimeoutMs?: number
}

export type ControlServer = {
  url: string
  token: string
  pending: ControlPendingQueue
  /**
   * True while a controller holds the slot AND its heartbeat is fresh: the
   * claim is bound to a per-claim id that only the claimant knows, released
   * only by its own /bye, and expired by silence.
   */
  hasController(): boolean
  /**
   * Subscribes to controller-lease transitions. Expiry is emitted by the
   * server's own timer even when no HTTP request ever arrives again, so a
   * terminal hold can follow a silent controller death (design D4). Returns
   * an unsubscribe function; disposed with the server.
   */
  onControllerLease(listener: (event: ControllerLeaseEvent) => void): () => void
  /** Phases the resident armed with [i] through the control channel. */
  isInteractiveArmed(phase: string): boolean
  /** Repoints the command handlers; the ControlProgress adapter wires run objects late. */
  setHandlers(handlers: ControlServerHandlers): void
  close(): void
}

export type ControllerLeaseEvent = "claimed" | "released" | "expired"

/** Header the controller client echoes on every request; doubles as the heartbeat. */
export const CONTROLLER_ID_HEADER = "x-convoy-controller"

export async function startControlServer(options: ControlServerOptions = {}): Promise<ControlServer> {
  const token = crypto.randomUUID()
  const hostname = options.hostname ?? "127.0.0.1"
  const port = await freePort(hostname)
  const pending = options.pending ?? new ControlPendingQueue()
  let handlers = options.handlers ?? {}
  const controllerTimeoutMs = options.controllerTimeoutMs ?? 15_000
  // The controller slot is claim-scoped: whoever wins /hello holds a secret id
  // no other caller (including an observer sharing the same bearer token)
  // knows. Only that id may release the slot or keep it alive.
  let controllerId: string | undefined
  let controllerLastSeen = 0
  const interactiveArmed = new Map<string, boolean>()
  const leaseListeners = new Set<(event: ControllerLeaseEvent) => void>()

  const controllerActive = () => controllerId !== undefined && Date.now() - controllerLastSeen < controllerTimeoutMs

  const notifyLease = (event: ControllerLeaseEvent) => {
    for (const listener of [...leaseListeners]) {
      try {
        listener(event)
      } catch (error) {
        log.warn(`[control] lease listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Autonomous expiry (design D4): a controller that dies without /bye is
  // detected even when it never sends another request. The interval is
  // bounded by the same lease the request path uses, and it is disposed with
  // the server so no timer outlives a finished run.
  const leaseTimer = setInterval(() => {
    if (controllerId === undefined) return
    if (Date.now() - controllerLastSeen < controllerTimeoutMs) return
    controllerId = undefined
    controllerLastSeen = 0
    notifyLease("expired")
  }, 1_000)
  leaseTimer.unref?.()

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch: (request) =>
      handleControl(request, token, pending, () => handlers, {
        controllerActive,
        claimController: () => {
          controllerId = crypto.randomUUID()
          controllerLastSeen = Date.now()
          notifyLease("claimed")
          return controllerId
        },
        releaseController: (id) => {
          if (!controllerActive() || id !== controllerId) return false
          controllerId = undefined
          controllerLastSeen = 0
          notifyLease("released")
          return true
        },
        refreshController: (id) => {
          if (controllerId !== undefined && id === controllerId) controllerLastSeen = Date.now()
        },
        isClaimant: (id) => controllerActive() && id !== null && id === controllerId,
        isInteractiveArmed: (phase) => interactiveArmed.get(phase) === true,
        setInteractiveArmed: (phase, armed) => void interactiveArmed.set(phase, armed),
      }),
  })
  const url = `http://${hostname}:${server.port}`
  log.info(`[control] server listening at ${url}`)
  return {
    url,
    token,
    pending,
    hasController: () => controllerActive(),
    onControllerLease: (listener) => {
      leaseListeners.add(listener)
      return () => leaseListeners.delete(listener)
    },
    isInteractiveArmed: (phase) => interactiveArmed.get(phase) === true,
    setHandlers: (next) => {
      handlers = next
    },
    close: () => {
      clearInterval(leaseTimer)
      leaseListeners.clear()
      server.stop(true)
    },
  }
}

type ControllerState = {
  controllerActive(): boolean
  /** Grants the slot to the caller and returns its claim id. */
  claimController(): string
  /** Frees the slot, but only for the id that claimed it. */
  releaseController(id: string): boolean
  /** Refreshes the claim's heartbeat; requests from anyone else don't. */
  refreshController(id: string | undefined): void
  /** True only for the live claimant's id — mutating routes require this. */
  isClaimant(id: string | null): boolean
  isInteractiveArmed(phase: string): boolean
  setInteractiveArmed(phase: string, armed: boolean): void
}

async function handleControl(
  request: Request,
  token: string,
  pending: ControlPendingQueue,
  getHandlers: () => ControlServerHandlers,
  state: ControllerState,
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("unauthorized", { status: 401 })
  }
  // Any authenticated request carrying the live controller's id counts as a
  // heartbeat; observers share the bearer token but never the claim id.
  const heartbeat = request.headers.get(CONTROLLER_ID_HEADER)
  state.refreshController(heartbeat === null ? undefined : heartbeat)
  const handlers = getHandlers()
  const url = new URL(request.url)
  const denyUnlessController = (): Response | undefined => {
    if (state.isClaimant(heartbeat)) return undefined
    return new Response("only the attached controller may do that", { status: 403 })
  }
  try {
    switch (`${request.method} ${url.pathname}`) {
      case "POST /hello": {
        const body = await readJson(request)
        const role = body?.role
        if (role !== "controller" && role !== "observer") {
          return new Response('role must be "controller" or "observer"', { status: 400 })
        }
        if (role === "controller" && state.controllerActive()) {
          return Response.json({ error: "a controller is already attached" }, { status: 409 })
        }
        if (role === "controller") {
          const controllerId = state.claimController()
          return Response.json({ ok: true, role, controllerId })
        }
        return Response.json({ ok: true, role })
      }
      case "POST /bye": {
        const body = await readJson(request)
        if (state.controllerActive()) {
          // Only the claimant releases the slot: an observer (or any other
          // caller sharing the token) must not be able to evict the live
          // controller and let a second one take over the gates.
          const id = typeof body?.controllerId === "string" ? body.controllerId : ""
          if (!state.releaseController(id)) {
            return Response.json({ error: "only the attached controller may release the slot" }, { status: 409 })
          }
        }
        return Response.json({ ok: true })
      }
      case "GET /pending":
        return Response.json(pending.snapshot())
      case "POST /permission": {
        const denied = denyUnlessController()
        if (denied) return denied
        const body = await readJson(request)
        const requestId = typeof body?.id === "string" ? body.id : ""
        const reply = body?.reply
        if (!requestId || !["once", "always", "reject"].includes(String(reply ?? ""))) {
          return new Response("permission requires { id, reply: \"once\" | \"always\" | \"reject\" }", { status: 400 })
        }
        if (!pending.resolvePermission(requestId, reply as PermissionReply)) {
          return new Response("no matching pending permission", { status: 404 })
        }
        return Response.json({ ok: true })
      }
      case "POST /human": {
        const denied = denyUnlessController()
        if (denied) return denied
        const body = await readJson(request)
        const requestId = typeof body?.id === "string" ? body.id : ""
        const action = body?.action
        if (!requestId || !["continue", "iterate", "abort", "retry", "reset"].includes(String(action ?? ""))) {
          return new Response("human requires { id, action: \"continue\" | \"iterate\" | \"abort\" | \"retry\" | \"reset\" }", { status: 400 })
        }
        if (!pending.resolveHuman(requestId, action as HumanReviewAction)) {
          return new Response("no matching pending human gate", { status: 404 })
        }
        return Response.json({ ok: true })
      }
      case "POST /finish-dismiss": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onFinishDismiss?.()
        pending.resolveFinish()
        return Response.json({ ok: true })
      }
      case "POST /pause": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onPause?.()
        return Response.json({ ok: true })
      }
      case "POST /resume": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onResume?.()
        return Response.json({ ok: true })
      }
      case "POST /abort": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onAbort?.()
        return Response.json({ ok: true })
      }
      case "POST /keep-awake": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onKeepAwakeToggle?.()
        return Response.json({ ok: true })
      }
      case "POST /keep-run-dir": {
        const denied = denyUnlessController()
        if (denied) return denied
        await handlers.onKeepRunDirRequested?.()
        return Response.json({ ok: true })
      }
      case "POST /interactive": {
        const denied = denyUnlessController()
        if (denied) return denied
        const body = await readJson(request)
        if (typeof body?.phase !== "string" || typeof body?.armed !== "boolean") {
          return new Response("interactive requires { phase: string, armed: boolean }", { status: 400 })
        }
        state.setInteractiveArmed(body.phase, body.armed)
        return Response.json({ ok: true })
      }
      case "POST /auto-accept": {
        const denied = denyUnlessController()
        if (denied) return denied
        const body = await readJson(request)
        const mode = body?.mode
        if (mode !== undefined && !["off", "all", "smart"].includes(String(mode))) {
          return new Response("auto-accept mode must be \"off\" | \"all\" | \"smart\"", { status: 400 })
        }
        let next: AutoAcceptMode
        if (mode !== undefined) {
          next = mode as AutoAcceptMode
        } else {
          next = cycleAutoAccept(handlers.autoAccept?.mode ?? "off")
        }
        if (handlers.onAutoAccept) await handlers.onAutoAccept(next)
        else if (handlers.autoAccept) handlers.autoAccept.mode = next
        return Response.json({ ok: true, mode: next })
      }
      case "GET /status": {
        const status = handlers.statusProvider?.() ?? {}
        return Response.json({ ok: true, ...status, controller: state.controllerActive() })
      }
      default:
        return new Response("method not allowed", { status: 405 })
    }
  } catch (error) {
    log.warn(`[control] request failed: ${error instanceof Error ? error.message : String(error)}`)
    return new Response("bad request", { status: 400 })
  }
}

function cycleAutoAccept(mode: AutoAcceptMode): AutoAcceptMode {
  if (mode === "off") return "all"
  if (mode === "all") return "smart"
  return "off"
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json()
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function freePort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, hostname, () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("couldn't find a free port for the control server"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}
