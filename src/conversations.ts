import { bootOpencodeServerFrom, connectOpencode } from "./opencode"
import { openSessionCommand, runForegroundChild, shellQuote, type SessionWindowBackend } from "./terminal-host"

/**
 * The minimal conversation adapter (capability `work-conversations`, design
 * D4): creates, validates, and opens an *exact public session reference* in a
 * resolved work context. Its initial implementation is OpenCode.
 *
 * Durable conversation references are plain data — harness id plus session id
 * — and never carry transient connection state; a reference is validated
 * against a live server before use and any transient handle stays inside this
 * module. The adapter does not imply support for advisor, model fan-out, or
 * verification flows: those remain the pipeline's `StepRunner` territory.
 */

/** A harness-qualified session reference (durable, storable). */
export type AuthoringSessionRef = {
  harness: "opencode"
  sessionId: string
}

/**
 * A live server connection used transiently while validating or creating.
 * `close` is optional on purpose: a conversation-service handle (task 4.3)
 * carries the URL but *no* shutdown right — the service outlives the call and
 * is stopped only through the service's explicit, guarded stop. Adapters
 * never close an injected handle.
 */
type ServerHandle = { url: string; close?(): void }

/**
 * Boots a bounded server rooted at the checkout, creates a session, and
 * returns the durable reference. The server is closed before returning — the
 * reference, not the connection, is what persists; the interactive client
 * that later opens the session starts (or reuses) its own server. A failed
 * creation surfaces the error to the caller, who owns recovery (design D3:
 * partial results are reported, never claimed complete).
 */
export async function createAuthoringConversation(input: {
  checkout: string
  title?: string
  bootTimeoutMs?: number
  /** Injected server (used by tests / a conversation service that owns one). */
  server?: ServerHandle
}): Promise<AuthoringSessionRef> {
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout, input.bootTimeoutMs))
  try {
    const client = connectOpencode(server.url)
    const created = await client.session.create(input.title ? { title: input.title } : {})
    if (created.error || !created.data) {
      throw new Error(`opencode session create failed: ${JSON.stringify(created.error ?? "no session returned")}`)
    }
    return { harness: "opencode", sessionId: created.data.id }
  } finally {
    // Only close servers this call booted; an injected one belongs to its owner.
    if (!input.server) server.close?.()
  }
}

/**
 * Validates a durable reference against a live server of the reference's
 * repository: the exact session must resolve. Unknown/unavailable is returned
 * as a tagged outcome — never substituted with "new conversation" (the
 * resume action must not claim continuity it cannot verify).
 */
export async function validateAuthoringSession(input: {
  ref: AuthoringSessionRef
  checkout: string
  server?: ServerHandle
}): Promise<{ status: "available"; title?: string } | { status: "unavailable"; reason: string }> {
  if (input.ref.harness !== "opencode") {
    return { status: "unavailable", reason: `unsupported conversation harness: ${input.ref.harness}` }
  }
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout))
  try {
    const client = connectOpencode(server.url)
    const got = await client.session.get({ sessionID: input.ref.sessionId })
    if (got.error || !got.data) {
      return { status: "unavailable", reason: `the linked session could not be opened through the harness (${JSON.stringify(got.error ?? "not found")})` }
    }
    return { status: "available", ...(got.data.title ? { title: got.data.title } : {}) }
  } finally {
    if (!input.server) server.close?.()
  }
}

/**
 * The argv that opens an authoring conversation in OpenCode's interactive
 * client, rooted at the work context's checkout with the exact session
 * resumed. Structured on purpose: the foreground host passes argv straight
 * to the child; shell-based external backends receive the quoted command.
 */
export function authoringClientArgv(input: { checkout: string; ref: AuthoringSessionRef }): string[] {
  return ["opencode", input.checkout, "--session", input.ref.sessionId]
}

/**
 * Foreground presentation (design D4): suspends the owning TUI, runs the
 * harness client with the terminal's own streams, and restores on exit — the
 * terminal host owns restoration in `finally`, so normal exit, failure, and
 * interruption all return control. Resolves with the child's exit code.
 */
export function openConversationForeground(input: {
  checkout: string
  ref: AuthoringSessionRef
  suspend(): void
  resume(): void
  env?: Record<string, string>
}): Promise<number> {
  return runForegroundChild({
    argv: authoringClientArgv({ checkout: input.checkout, ref: input.ref }),
    cwd: input.checkout,
    suspend: input.suspend,
    resume: input.resume,
    ...(input.env ? { env: input.env } : {}),
  })
}

/**
 * External presentation (capability work-conversations): opens the linked
 * conversation in a supported external window or pane — same validated work
 * and session reference as the foreground path. The three facts are reported
 * independently (task 4.6): a pane result proves only that a pane was
 * created; the separate session check proves only that the *persisted*
 * session resolves, not that the pane's client started (pane backends expose
 * no child handle, so client startup is unobservable and never claimed).
 */
export async function openConversationExternal(input: {
  checkout: string
  ref: AuthoringSessionRef
  /** Injected window launcher (tests); defaults to the detected backend. */
  openWindow?: () => Promise<SessionWindowBackend>
  /** Injected server for the availability check (tests). */
  server?: Parameters<typeof validateAuthoringSession>[0]["server"]
}): Promise<{ status: "opened"; backend: string; sessionVerified: true } | { status: "opened-unverified"; backend: string; reason: string } | { status: "failed"; reason: string }> {
  let backend: SessionWindowBackend
  try {
    const open = input.openWindow ?? (() => openSessionCommand(authoringClientArgv({ checkout: input.checkout, ref: input.ref }).map(shellQuote).join(" "), input.checkout, "convoy conversation"))
    backend = await open()
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
  // Pane created: that says nothing about the harness. Verify the exact
  // session before reporting the conversation as running; a verification
  // error is an honest "unverified", never a crash through the pane result.
  let verified: Awaited<ReturnType<typeof validateAuthoringSession>>
  try {
    verified = await validateAuthoringSession({ ref: input.ref, checkout: input.checkout, ...(input.server ? { server: input.server } : {}) })
  } catch (error) {
    return { status: "opened-unverified", backend, reason: error instanceof Error ? error.message : String(error) }
  }
  if (verified.status === "available") return { status: "opened", backend, sessionVerified: true }
  return { status: "opened-unverified", backend, reason: verified.reason }
}

/**
 * Whether the session's agent is actively executing right now (design D5:
 * view detachment is not evidence the agent stopped). `idle` proves the
 * session is quiescent; `busy` proves a writer is live; `unknown` means the
 * harness could not answer — callers must treat that as a live writer
 * (reconciliation, not takeover).
 */
export async function sessionActivity(input: {
  checkout: string
  ref: AuthoringSessionRef
  server?: ServerHandle
}): Promise<"busy" | "idle" | "unknown"> {
  if (input.ref.harness !== "opencode") return "unknown"
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout))
  try {
    const client = connectOpencode(server.url)
    const status = await client.session.status()
    if (status.error || !status.data) return "unknown"
    const entry = (status.data as Record<string, { type?: string }>)[input.ref.sessionId]
    if (!entry?.type) return "idle"
    return entry.type === "busy" || entry.type === "retry" ? "busy" : "idle"
  } catch {
    return "unknown"
  } finally {
    if (!input.server) server.close?.()
  }
}

/**
 * The project's authoring commands (capability work-context, task 5.3):
 * discovery through the public command API. Absence is a real outcome —
 * Propose reports unavailable and ordinary conversation stays usable; Convoy
 * never installs global commands or imitates the workflow.
 */
export async function listAuthoringCommands(input: {
  checkout: string
  server?: ServerHandle
}): Promise<string[] | "unknown"> {
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout))
  try {
    const client = connectOpencode(server.url)
    const commands = await client.command.list()
    if (commands.error || !commands.data) return "unknown"
    return (commands.data as Array<{ name?: string }>).map((entry) => entry.name).filter((name): name is string => typeof name === "string")
  } catch {
    return "unknown"
  } finally {
    if (!input.server) server.close?.()
  }
}

/**
 * Sends the project's authoring command into a session (task 5.3): the
 * command runs inside the harness against the selected checkout's OpenSpec
 * state — Convoy never authors OpenSpec artifacts itself. Requires a live
 * server handle (the caller's conversation service or a bounded boot); the
 * command executes asynchronously, so the foreground client is how the
 * operator watches and steers it.
 */
export async function invokeAuthoringCommand(input: {
  ref: AuthoringSessionRef
  server: ServerHandle
  command: string
  arguments?: string
}): Promise<void> {
  const client = connectOpencode(input.server.url)
  const sent = await client.session.command({
    sessionID: input.ref.sessionId,
    command: input.command,
    ...(input.arguments ? { arguments: input.arguments } : {}),
  })
  if (sent.error) {
    throw new Error(`authoring command "${input.command}" failed: ${JSON.stringify(sent.error).slice(0, 200)}`)
  }
}
