import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { claudeAuthShellPrefix, claudeBinaryName } from "./claude-code"
import { withoutHerdrEnv } from "./herdr"
import { bootOpencodeServerFrom, connectOpencode } from "./opencode"
import { resolveOpencodeBin } from "./opencode-runtime"
import { resolveClaudeAuth } from "./runners/claude/auth"
import { applyAuthOverlay } from "./runners/claude/effective-auth"
import type { AuthenticationSelection } from "./runners/contracts"
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
 *
 * Claude is the second harness (`defaults.authoring.runner: claude-code`): its
 * sessions need no server — a new conversation is a fresh session id the
 * client starts with `--session-id`, and an existing one is the exact
 * transcript Claude persisted for that checkout, reopened with `--resume` —
 * and every client runs under the reviewed Claude authentication.
 */

export type AuthoringHarness = "opencode" | "claude-code"

/** A harness-qualified session reference (durable, storable). */
export type AuthoringSessionRef = {
  harness: AuthoringHarness
  sessionId: string
}

/** The harness an authoring flow opens and the authentication a Claude client runs under. */
export type AuthoringRoute = { harness: AuthoringHarness; auth?: AuthenticationSelection }

/** Where Claude persists a checkout's sessions: `<config>/projects/<checkout with non-alphanumerics as ->/`. */
export function claudeSessionFile(checkout: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  let real = checkout
  try {
    real = realpathSync(checkout)
  } catch {
    // A missing checkout simply has no sessions.
  }
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", real.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`)
}

/** True once Claude has persisted the session for this exact checkout. */
export function claudeSessionExists(checkout: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return /^[0-9a-f-]{36}$/i.test(sessionId) && existsSync(claudeSessionFile(checkout, sessionId, env))
}

/**
 * A live server connection used transiently while validating or creating.
 * `close` is optional on purpose: a conversation-service handle (task 4.3)
 * carries the URL but *no* shutdown right — the service outlives the call and
 * is stopped only through the service's explicit, guarded stop. Adapters
 * never close an injected handle.
 */
type ServerHandle = { url: string; password?: string; close?(): void | Promise<unknown> }

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
  harness?: AuthoringHarness
}): Promise<AuthoringSessionRef> {
  // A Claude conversation exists once its client starts with this id.
  if (input.harness === "claude-code") return { harness: "claude-code", sessionId: randomUUID() }
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout, input.bootTimeoutMs))
  try {
    const client = connectOpencode(server.url, server.password)
    const created = await client.session.create(input.title ? { title: input.title } : {})
    if (created.error || !created.data) {
      throw new Error(`opencode session create failed: ${JSON.stringify(created.error ?? "no session returned")}`)
    }
    return { harness: "opencode", sessionId: created.data.id }
  } finally {
    // Only close servers this call booted; an injected one belongs to its owner.
    if (!input.server) await server.close?.()
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
  if (input.ref.harness === "claude-code") {
    return claudeSessionExists(input.checkout, input.ref.sessionId)
      ? { status: "available" }
      : { status: "unavailable", reason: "Claude has no persisted session with this id for this checkout" }
  }
  if (input.ref.harness !== "opencode") {
    return { status: "unavailable", reason: `unsupported conversation harness: ${String(input.ref.harness)}` }
  }
  const server = input.server ?? (await bootOpencodeServerFrom(input.checkout))
  try {
    const client = connectOpencode(server.url, server.password)
    const got = await client.session.get({ sessionID: input.ref.sessionId })
    if (got.error || !got.data) {
      return { status: "unavailable", reason: `the linked session could not be opened through the harness (${JSON.stringify(got.error ?? "not found")})` }
    }
    return { status: "available", ...(got.data.title ? { title: got.data.title } : {}) }
  } finally {
    if (!input.server) await server.close?.()
  }
}

/**
 * The argv that opens an authoring conversation in OpenCode's interactive
 * client, rooted at the work context's checkout with the exact session
 * resumed. Structured on purpose: the foreground host passes argv straight
 * to the child; shell-based external backends receive the quoted command.
 */
export function authoringClientArgv(input: { checkout: string; ref: AuthoringSessionRef; prompt?: string }): string[] {
  if (input.ref.harness === "claude-code") {
    // Resume the exact persisted session, or start this id fresh.
    const session = claudeSessionExists(input.checkout, input.ref.sessionId) ? ["--resume", input.ref.sessionId] : ["--session-id", input.ref.sessionId]
    return [claudeBinaryName, ...session, ...(input.prompt ? [input.prompt] : [])]
  }
  // --standalone keeps V1's own-server behavior; V2 otherwise joins the
  // user's background service.
  return [resolveOpencodeBin(), input.checkout, "--standalone", "--session", input.ref.sessionId, ...(input.prompt ? ["--prompt", input.prompt] : [])]
}

/** The child environment a Claude client runs with: the reviewed auth overlay, never an ambient billing source. */
export function claudeClientEnv(auth: AuthenticationSelection = { mode: "subscription" }, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const child = applyAuthOverlay(withoutHerdrEnv(env), resolveClaudeAuth({ selection: auth, env }))
  return Object.fromEntries(Object.entries(child).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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
  /** The reviewed authentication for a Claude conversation. */
  auth?: AuthenticationSelection
  /** A first message the client starts with (the authoring command). */
  prompt?: string
  /** Injected primary-screen clear (tests); the host's terminal clear by default. */
  clear?: () => void
}): Promise<number> {
  const env = input.env ?? (input.ref.harness === "claude-code" ? claudeClientEnv(input.auth) : undefined)
  return runForegroundChild({
    argv: authoringClientArgv({ checkout: input.checkout, ref: input.ref, ...(input.prompt ? { prompt: input.prompt } : {}) }),
    cwd: input.checkout,
    suspend: input.suspend,
    resume: input.resume,
    ...(env ? { env } : {}),
    ...(input.clear ? { clear: input.clear } : {}),
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
  /** The reviewed authentication for a Claude conversation. */
  auth?: AuthenticationSelection
}): Promise<{ status: "opened"; backend: string; sessionVerified: true } | { status: "opened-unverified"; backend: string; reason: string } | { status: "failed"; reason: string }> {
  let backend: SessionWindowBackend
  try {
    const command = authoringClientArgv({ checkout: input.checkout, ref: input.ref }).map(shellQuote).join(" ")
    // A Claude pane's shell gets the same auth overlay, typed as variable names only.
    const typed = input.ref.harness === "claude-code" ? `${claudeAuthShellPrefix(input.auth)} ${command}` : command
    const open = input.openWindow ?? (() => openSessionCommand(typed, input.checkout, "convoy conversation"))
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
    const client = connectOpencode(server.url, server.password)
    const status = await client.session.status()
    if (status.error || !status.data) return "unknown"
    const entry = (status.data as Record<string, { type?: string }>)[input.ref.sessionId]
    if (!entry?.type) return "idle"
    return entry.type === "busy" || entry.type === "retry" ? "busy" : "idle"
  } catch {
    return "unknown"
  } finally {
    if (!input.server) await server.close?.()
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
    const client = connectOpencode(server.url, server.password)
    const commands = await client.command.list()
    if (commands.error || !commands.data) return "unknown"
    return (commands.data as Array<{ name?: string }>).map((entry) => entry.name).filter((name): name is string => typeof name === "string")
  } catch {
    return "unknown"
  } finally {
    if (!input.server) await server.close?.()
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
  const client = connectOpencode(input.server.url, input.server.password)
  const sent = await client.session.command({
    sessionID: input.ref.sessionId,
    command: input.command,
    ...(input.arguments ? { arguments: input.arguments } : {}),
  })
  if (sent.error) {
    throw new Error(`authoring command "${input.command}" failed: ${JSON.stringify(sent.error).slice(0, 200)}`)
  }
}

/**
 * A Claude project's authoring commands: the slash commands its checkout
 * defines (`.claude/commands/**.md`, `/a:b` for `a/b.md`, and
 * `.claude/skills/<name>/SKILL.md` as `<name>`). Absence is a real
 * outcome, as with OpenCode's command API.
 */
export async function listClaudeAuthoringCommands(checkout: string): Promise<string[]> {
  const names = new Set<string>()
  const commands = join(checkout, ".claude", "commands")
  if (existsSync(commands)) {
    for await (const path of new Bun.Glob("**/*.md").scan({ cwd: commands })) names.add(path.slice(0, -".md".length).split("/").join(":"))
  }
  const skills = join(checkout, ".claude", "skills")
  if (existsSync(skills)) {
    for await (const path of new Bun.Glob("*/SKILL.md").scan({ cwd: skills })) names.add(path.split("/")[0]!)
  }
  return [...names].sort()
}
