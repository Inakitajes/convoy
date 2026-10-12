import { stdout } from "node:process"

import type { OpencodeClient } from "./opencode-client"

import { getSessionEventHub, payloadProperties } from "./event-hub"
import { log } from "./log"
import { writeReportToolName } from "./report"
import { noopProgress, type AutoAccept, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "./progress"
import { explainCommand, judgeCommand } from "./safety-judge"
import { createTerminalInput, type TerminalInput } from "./terminal-input"

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

/** Tools that look like a doom loop when paging through a large file. */
export const doomLoopAllowTools = new Set(["read", "grep", "glob", "list", writeReportToolName])

type Reply = PermissionReply

export type PermissionGate = {
  stop(): Promise<void>
  /**
   * While a session is paused, its permission requests are left for whoever owns
   * the terminal (e.g. an interactive OpenCode TUI the user opened with [o]).
   * Structural bash-checkpoint decisions still run: pausing must not make a
   * read-only verify session's hard refusal human-approvable.
   * Sibling sessions in the same `models:`/`parallel` batch keep being handled,
   * so a failed step's recovery can never deadlock a live sibling's prompts.
   *
   * Omit `sessionID` to pause every session (the solo human-review gate, which
   * never shares a batch with live siblings).
   */
  pause(sessionID?: string): void
  resume(sessionID?: string): void
}

/**
 * What the advisor checkpoint wants done with an `edit` request.
 *
 * - `advise`: this is the phase's first write and it hasn't consulted yet.
 *   Reject carrying the advice, which the executor reads mid-turn and retries on.
 * - `allow`: an advised phase that already consulted. Allowed immediately, never
 *   escalated — advised agents run with `edit: "ask"` purely so this hook can
 *   see the first write, so without this branch every later edit would start
 *   prompting a human that today is never asked.
 * - `defer`: not the checkpoint's business; handle as normal.
 */
export type AdvisorGateDecision = { action: "advise"; message: string } | { action: "allow" } | { action: "defer" }

export type AdvisorCheckpoint = (request: { sessionID: string; permission: string; summary: string }) => Promise<AdvisorGateDecision>

export type StartGateOptions = {
  client: OpencodeClient
  progress?: ProgressUI
  interactive: boolean
  directory: string
  /** When enabled, ask-level requests are auto-allowed ("once") instead of prompting. */
  autoAccept?: AutoAccept
  /** Model used by the smart auto-accept judge; required for "smart" mode to do anything. */
  judgeModel?: { providerID: string; modelID: string }
  /**
   * Consulted for `edit` requests before anything else, including --yolo. It is
   * not a safety decision, so auto-accept must not skip it: the point of the
   * checkpoint is that the first write of a phase is preceded by a consultation,
   * which is what makes the advisor reliable rather than a matter of judgement.
   */
  advisorCheckpoint?: AdvisorCheckpoint
  /** Serializes terminal input with the phase gate so a --no-tui parallel run never opens two readlines on stdin. */
  terminalInput?: TerminalInput
  /** The opencode server URL for [i] inspect to attach to. Absent in readline fallback on non-macOS. */
  serverUrl?: string
  /** The server's generated password, which the inspect window's client needs to connect. */
  serverPassword?: string
}

export function startPermissionGate(options: StartGateOptions): PermissionGate {
  const progress = options.progress ?? noopProgress
  const controller = new AbortController()
  const handled = new Set<string>()
  const queue = serialQueue()
  // Session-scoped pause: only the session an interactive TUI owns is left for
  // that owner. A directory-wide flag would also drop the prompts of live
  // siblings in the same parallel batch, deadlocking them waiting for replies
  // Convoy would never send. `pausedAll` covers the solo human-review gate,
  // which never shares a batch with concurrent siblings.
  const pausedSessions = new Set<string>()
  let pausedAll = false
  const terminalInput = options.terminalInput ?? createTerminalInput()

  // permission.asked is delivered on the directory-scoped event bus, so we share
  // the run's single subscription for that directory (see event-hub) instead of
  // opening a second one just for the gate. onAny sees every event regardless of
  // session, which is what a permission request — not tied to one phase — needs.
  const hub = getSessionEventHub(options.client, options.directory)
  const unsubscribe = hub.onAny((payload) => {
    if (controller.signal.aborted) return
    const request = permissionRequestFrom(payload)
    if (!request) return
    if (handled.has(request.id)) return
    if (pausedAll || pausedSessions.has(request.sessionID)) return
    handled.add(request.id)
    queue(() =>
      handleRequest(options.client, request, options.interactive, progress, options.directory, options.autoAccept, options.judgeModel, controller.signal, options.advisorCheckpoint, terminalInput, options.serverUrl, options.serverPassword),
    )
  })

  return {
    async stop() {
      unsubscribe()
      controller.abort(new Error("permission gate stopped"))
    },
    pause(sessionID) {
      if (sessionID) pausedSessions.add(sessionID)
      else pausedAll = true
    },
    resume(sessionID) {
      if (sessionID) pausedSessions.delete(sessionID)
      else pausedAll = false
    },
  }
}

/**
 * Normalizes a `permission.asked` event into Convoy's request shape. V1 nests
 * the request under `properties` and names the fields `permission`/`patterns`;
 * V2 puts it under `data` and names them `action`/`resources`.
 */
export function permissionRequestFrom(payload: unknown): PermissionRequest | undefined {
  if (!payload || typeof payload !== "object") return undefined
  if ((payload as { type?: unknown }).type !== "permission.asked") return undefined
  const raw = payloadProperties(payload)
  if (!raw || typeof raw !== "object" || !("id" in raw)) return undefined
  const record = raw as Record<string, unknown>
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  const permission = typeof record.permission === "string" ? record.permission : typeof record.action === "string" ? record.action : ""
  const patterns = record.patterns !== undefined ? strings(record.patterns) : strings(record.resources)
  return {
    id: typeof record.id === "string" ? record.id : String(record.id),
    sessionID: typeof record.sessionID === "string" ? record.sessionID : "",
    permission,
    patterns,
    metadata: record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {},
    always: strings(record.always),
    ...(record.tool && typeof record.tool === "object" ? { tool: record.tool as { messageID: string; callID: string } } : {}),
  }
}

async function handleRequest(
  client: OpencodeClient,
  request: PermissionRequest,
  interactive: boolean,
  progress: ProgressUI,
  directory: string,
  autoAccept?: AutoAccept,
  judgeModel?: { providerID: string; modelID: string },
  signal?: AbortSignal,
  advisorCheckpoint?: AdvisorCheckpoint,
  terminalInput: TerminalInput = createTerminalInput(),
  serverUrl?: string,
  serverPassword?: string,
) {
  const summary = describeRequest(request)

  // OpenCode's schema only accepts ask/allow/deny for doom_loop, not a
  // per-tool map. Ask, then decide here: sectional reads are not a loop;
  // a write/bash loop cannot be overridden by --yolo.
  if (request.permission === "doom_loop") {
    const tool = pickString(request.metadata, ["tool"]) || request.patterns[0]
    if (tool && doomLoopAllowTools.has(tool)) {
      log.info(`[permission] allowed doom_loop on ${tool}: ${summary}`)
      await reply(client, request, directory, "once")
      return
    }
    log.warn(`[permission] denied doom_loop on ${tool ?? "unknown"}: ${summary}`)
    progress.message(`denied doom loop: ${summary}`)
    await reply(client, request, directory, "reject", "Convoy rejected: doom loop on a mutating tool")
    return
  }

  // Before every other branch, including --yolo: the checkpoint is structural,
  // not a safety judgement, and skipping it would turn "the first write is
  // preceded by a consultation" back into something the model decides.
  if (advisorCheckpoint && request.permission === "edit") {
    const decision = await advisorCheckpoint({ sessionID: request.sessionID, permission: request.permission, summary })
    if (decision.action === "advise") {
      log.info(`[permission] advisor checkpoint held the first write: ${summary}`)
      progress.message(`advisor consulted before first write: ${summary}`)
      await reply(client, request, directory, "reject", decision.message)
      return
    }
    if (decision.action === "allow") {
      await reply(client, request, directory, "once")
      return
    }
  }

  // Read at handling time, not subscription time: the TUI flips this live.
  // Opencode's denylist already rejected anything hard-denied, so whatever
  // reaches here is exactly the "ask" bucket auto-accept is meant to cover.
  if (autoAccept?.mode === "all") {
    log.info(`[permission] auto-allowed (auto-accept on): ${summary}`)
    progress.message(`auto-allowed: ${summary}`)
    await reply(client, request, directory, "once")
    return
  }

  // Smart mode delegates the call to an AI judge running outside the agentic
  // loop. A "safe" verdict auto-allows; anything else (incl. judge failure,
  // which is fail-closed) drops through to the normal human prompt below.
  let judgeReason: string | undefined
  let verdictReason: string | undefined
  if (autoAccept?.mode === "smart" && judgeModel) {
    progress.message(`evaluating safety: ${summary}`)
    const verdict = await judgeCommand(client, { request: promptInfo(request), model: judgeModel, directory, signal })
    if (verdict.safe) {
      log.info(`[permission] smart-allowed: ${summary} — ${verdict.reason}`)
      progress.message(`smart-allowed: ${summary} — ${verdict.reason}`)
      await reply(client, request, directory, "once")
      return
    }
    log.info(`[permission] smart auto-accept escalating to user: ${summary} — ${verdict.reason}`)
    judgeReason = `flagged by safety judge: ${verdict.reason}`
    verdictReason = verdict.reason
  }

  // The UI (dashboard, or the control adapter on a coordinated run) resolves
  // the prompt in-place; it wins even without a TTY — a coordinated run has no
  // terminal on the coordinator, so "interactive" means "a controller can
  // answer", not `stdin.isTTY`. Without a controller the adapter's promise
  // simply holds: prompts are never auto-rejected just because nobody is
  // attached right now. The readline fallback is only for the plain-logs case
  // and goes through the shared terminal-input arbiter so it can never race a
  // phase-gate readline for the same stdin in a --no-tui parallel run.
  const ask = progress.askPermission?.bind(progress)
  if (ask) {
    const answer = await ask(promptInfoForUser(request, judgeReason, verdictReason, judgeModel, client, directory, signal))
    log.info(`[permission] replied ${answer} for ${request.permission}`)
    await reply(client, request, directory, answer, answer === "reject" ? "rejected by user" : undefined)
    return
  }

  // True non-interactive CI (no UI at all) must not hang. Once executeRun
  // always coordinates, this branch is unreachable in production; it stays as
  // a failsafe for unit tests that build a bare gate.
  if (!interactive) {
    log.warn(`[permission] auto-rejecting ${request.permission} (no TTY): ${summary}`)
    await reply(client, request, directory, "reject", "Convoy rejected: non-interactive run")
    return
  }

  const answer = await terminalInput.withInput(async (prompt) => {
    progress.suspend()
    try {
      log.section("permission request")
      stdout.write(formatRequest(request, judgeReason))
      for (;;) {
        const raw = (await prompt.ask("approve? [o]nce, [a]lways, [r]eject, [e]xplain, [i]nspect > ")).trim().toLowerCase()
        if (raw === "o" || raw === "once" || raw === "y" || raw === "yes") return "once" as Reply
        if (raw === "a" || raw === "always") return "always" as Reply
        if (raw === "r" || raw === "reject" || raw === "n" || raw === "no") return "reject" as Reply
        if (raw === "e" || raw === "explain") {
          if (judgeModel) {
            const explanation = await explainCommand(client, {
              request: promptInfo(request),
              model: judgeModel,
              directory,
              signal: AbortSignal.any([signal ?? new AbortController().signal, new AbortController().signal]),
              verdictReason,
            })
            stdout.write(`\n${explanation}\n\n`)
          } else {
            stdout.write("\nno safety judge configured to explain this\n\n")
          }
          continue
        }
        if (raw === "i" || raw === "inspect") {
          if (serverUrl && request.sessionID) {
            try {
              const { openOpencodeSessionWindow } = await import("./opencode")
              const backend = await openOpencodeSessionWindow({
                url: serverUrl,
                ...(serverPassword ? { password: serverPassword } : {}),
                targetDir: directory,
                sessionID: request.sessionID,
              })
              stdout.write(`\nopened session in ${backend}\n\n`)
            } catch (error) {
              stdout.write(`\ncouldn't open session: ${error instanceof Error ? error.message : String(error)}\n\n`)
            }
          } else if (!serverUrl) {
            stdout.write("\nno live opencode server to attach to\n\n")
          } else {
            stdout.write("\nthis request has no session to inspect\n\n")
          }
          continue
        }
        stdout.write("Choose o, a, r, e, or i.\n")
      }
    } finally {
      progress.resume()
    }
  })
  log.info(`[permission] replied ${answer} for ${request.permission}`)
  await reply(client, request, directory, answer, answer === "reject" ? "rejected by user" : undefined)
}

function promptInfo(request: PermissionRequest, judgeReason?: string): PermissionPromptInfo {
  return {
    id: request.id,
    permission: request.permission,
    patterns: request.patterns.slice(0, 5),
    command: pickString(request.metadata, ["command", "cmd"]) || undefined,
    target: pickString(request.metadata, ["path", "file", "url"]) || undefined,
    description: pickString(request.metadata, ["description"]) || undefined,
    sessionID: request.sessionID,
    ...(judgeReason ? { judgeReason } : {}),
  }
}

/**
 * Builds the `PermissionPromptInfo` for the user-facing prompt (TUI or readline).
 * This is the same as `promptInfo` but adds the `explain` callback when a judge
 * model is available. `promptInfo` itself stays free of callbacks because it is
 * also the `JudgeRequest` that feeds `judgeCommand`.
 */
function promptInfoForUser(
  request: PermissionRequest,
  judgeReason?: string,
  verdictReason?: string,
  judgeModel?: { providerID: string; modelID: string },
  client?: OpencodeClient,
  directory?: string,
  signal?: AbortSignal,
): PermissionPromptInfo {
  const info = promptInfo(request, judgeReason)
  if (judgeModel && client && directory) {
    info.explain = (explainSignal?: AbortSignal) => {
      const combined = signal && explainSignal ? AbortSignal.any([signal, explainSignal]) : (signal ?? explainSignal)
      return explainCommand(client, {
        request: promptInfo(request),
        model: judgeModel,
        directory,
        signal: combined,
        verdictReason,
      })
    }
  }
  return info
}

async function reply(client: OpencodeClient, request: PermissionRequest, directory: string, choice: Reply, message?: string) {
  // The reply must carry the same session and directory scope as the request
  // that asked: V2 routes `permission.reply` by sessionID, and a server hosting
  // multiple instances routes the directory-scoped request to the right one.
  const result = await client.permission.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    directory,
    reply: choice,
    ...(message ? { message } : {}),
  })
  if (result.error) log.warn(`[permission] reply error for ${request.id}: ${String((result.error as { message?: unknown }).message ?? result.error)}`)
}

function describeRequest(request: PermissionRequest) {
  const command = pickString(request.metadata, ["command", "cmd", "path", "url", "file"])
  if (command) return `${request.permission}: ${truncate(command, 200)}`
  if (request.patterns.length > 0) return `${request.permission}: ${request.patterns.slice(0, 3).join(", ")}`
  return request.permission
}

function formatRequest(request: PermissionRequest, judgeReason?: string) {
  const lines: string[] = [""]
  if (judgeReason) lines.push(`⚠ ${judgeReason}`)
  lines.push(`category: ${request.permission}`)
  if (request.tool) lines.push(`tool call: ${request.tool.callID}`)
  lines.push(`session: ${request.sessionID}`)
  if (request.patterns.length > 0) lines.push(`patterns: ${request.patterns.slice(0, 5).join(", ")}`)
  const command = pickString(request.metadata, ["command", "cmd"])
  if (command) lines.push(`command: ${truncate(command, 400)}`)
  const path = pickString(request.metadata, ["path", "file", "url"])
  if (path) lines.push(`target: ${truncate(path, 400)}`)
  const description = pickString(request.metadata, ["description"])
  if (description) lines.push(`note: ${truncate(description, 240)}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function pickString(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return ""
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return (job: () => Promise<unknown>) => {
    tail = tail.then(job, job)
  }
}
