import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import type { FilePartInput } from "./opencode-client"

import { withoutHerdrEnv } from "./herdr"
import { ndjsonLines } from "./ndjson"
import { RawStreamLog } from "./raw-stream-log"
import { openSessionCommand, shellQuote, type SessionWindowBackend } from "./opencode"
import { resolveClaudeAuth } from "./runners/claude/auth"
import { applyAuthOverlay } from "./runners/claude/effective-auth"
import type { AuthenticationSelection } from "./runners/contracts"
import type { ProgressMessage, ProgressTokens, ProgressUI } from "./progress"
import { stepRunnerFor } from "./step-runners"
import { ensureRunnersAvailable, whichOnPath } from "./runner-installation"
import type { Pipeline } from "./types"

/**
 * Claude Code helpers shared by the runner and the CLI: binary discovery, the
 * stream-json event decoder the adapter (runners/claude/adapter.ts) renders,
 * the raw stream log, and reopening a finished session (`claude --resume`,
 * `[o]`) or an interactive window under the reviewed auth overlay. Attempts
 * themselves run through the adapter, never through this module.
 */

export { ndjsonLines }

export const claudeBinaryName = "claude"

/** Read-only toolset mirroring agents.ts' read-only OpenCode agent config. */
const allowedTools = "Read,Glob,Grep"
const disallowedTools = "Write,Edit,NotebookEdit,Bash,Task,WebFetch,WebSearch"
const readOnlyToolArgs = [
  "--safe-mode",
  "--tools",
  allowedTools,
  "--disallowedTools",
  disallowedTools,
  "--permission-mode",
  "dontAsk",
]

export function pipelineUsesClaudeCode(pipeline: Pipeline): boolean {
  return pipeline.steps.some((step) => step.type === "agent" && step.runner === "claude-code")
}

export { whichOnPath }

/**
 * Fail-fast dependency check: Claude Code is optional — only a pipeline that
 * actually contains a claude-code step requires the CLI, and it must fail at
 * launch, never minutes into a run. (The runner-generic check is
 * `ensureRunnersAvailable`.)
 */
export function ensureClaudeAvailable(pipeline: Pipeline, which: (bin: string) => string | null = whichOnPath) {
  ensureRunnersAvailable(pipeline, which, ["claude-code"])
}

/** Display label for attempt lines and usage rows, mirroring provider/model formatting. */
export function claudeModelLabel(model: string): string {
  return stepRunnerFor("claude-code").modelLabel(model)
}

// ---------------------------------------------------------------------------
// stream-json → Convoy signals
// ---------------------------------------------------------------------------

/** What one NDJSON event means for the dashboard/logs; promptClaudePhase maps these onto ProgressUI. */
export type ClaudeSignal =
  | { type: "session"; sessionID: string }
  | { type: "message"; message: ProgressMessage }
  | { type: "activity"; message: string; kind: "tool" | "think" | "write" | "error"; pulse?: boolean }
  | { type: "result"; subtype: string; text: string; cost?: number; tokens?: ProgressTokens; isError: boolean }

export type ClaudeStreamState = {
  reasoningChars: number
  textChars: number
  // Counts content blocks across the whole stream so each thinking/text block
  // becomes its own transcript block: consecutive thinking blocks are separate
  // thoughts, not one run-on paragraph.
  block: number
}

export function newClaudeStreamState(): ClaudeStreamState {
  return { reasoningChars: 0, textChars: 0, block: 0 }
}

/**
 * Translates one parsed stream-json event into dashboard signals. Deltas feed
 * the live session transcript verbatim; tool calls become one-line markers;
 * char-count pulses update the status line without flooding the activity feed
 * (same density as the OpenCode event path).
 */
export function describeClaudeEvent(event: unknown, state: ClaudeStreamState): ClaudeSignal[] {
  if (!event || typeof event !== "object") return []
  const record = event as Record<string, unknown>

  if (record.type === "system" && record.subtype === "init" && typeof record.session_id === "string") {
    return [{ type: "session", sessionID: record.session_id }]
  }

  if (record.type === "stream_event") {
    if (eventType(record.event) === "content_block_start") state.block++
    const delta = deltaOf(record.event)
    if (!delta) return []
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      state.textChars += delta.text.length
      return [
        { type: "message", message: { channel: "response", text: delta.text, partID: `block:${state.block}` } },
        { type: "activity", message: `responding… (${formatCharCount(state.textChars)} chars)`, kind: "write", pulse: true },
      ]
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      state.reasoningChars += delta.thinking.length
      return [
        { type: "message", message: { channel: "reasoning", text: delta.thinking, partID: `block:${state.block}` } },
        { type: "activity", message: `thinking… (${formatCharCount(state.reasoningChars)} chars)`, kind: "think", pulse: true },
      ]
    }
    return []
  }

  // Complete assistant messages only contribute tool-call markers: their text
  // already streamed via deltas, so re-emitting it would duplicate the transcript.
  if (record.type === "assistant") {
    return toolUseBlocks(record.message).map((block) => {
      const line = `tool: ${block.name}${block.detail ? ` ${block.detail}` : ""}`
      return [
        { type: "activity", message: line, kind: "tool" } as const,
        { type: "message", message: { channel: "tool", text: line } } as const,
      ]
    }).flat()
  }

  if (record.type === "result") {
    const subtype = typeof record.subtype === "string" ? record.subtype : "unknown"
    const tokens = claudeTokens(record.usage)
    return [
      {
        type: "result",
        subtype,
        text: typeof record.result === "string" ? record.result : "",
        ...(typeof record.total_cost_usd === "number" && Number.isFinite(record.total_cost_usd) ? { cost: record.total_cost_usd } : {}),
        ...(tokens ? { tokens } : {}),
        isError: record.is_error === true || subtype !== "success",
      },
    ]
  }

  return []
}

function eventType(event: unknown): string {
  if (!event || typeof event !== "object") return ""
  const type = (event as Record<string, unknown>).type
  return typeof type === "string" ? type : ""
}

function deltaOf(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined
  const delta = (event as Record<string, unknown>).delta
  if (!delta || typeof delta !== "object") return undefined
  return delta as Record<string, unknown>
}

function toolUseBlocks(message: unknown): { name: string; detail: string }[] {
  if (!message || typeof message !== "object") return []
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  const out: { name: string; detail: string }[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const record = block as Record<string, unknown>
    if (record.type !== "tool_use" || typeof record.name !== "string") continue
    out.push({ name: record.name, detail: toolDetail(record.input) })
  }
  return out
}

/** One short human-readable argument for the log line: path, pattern, or truncated JSON. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["file_path", "path", "pattern", "query", "url", "command"]) {
    if (typeof record[key] === "string" && record[key]) return truncate(String(record[key]), 120)
  }
  const json = JSON.stringify(record)
  return json === "{}" ? "" : truncate(json, 120)
}

/** Normalizes the Claude API usage shape into ProgressTokens. */
export function claudeTokens(value: unknown): ProgressTokens | undefined {
  if (!value || typeof value !== "object") return undefined
  const usage = value as Record<string, unknown>
  const input = numberToken(usage.input_tokens)
  const output = numberToken(usage.output_tokens)
  const cacheRead = numberToken(usage.cache_read_input_tokens)
  const cacheWrite = numberToken(usage.cache_creation_input_tokens)
  if (input + output + cacheRead + cacheWrite === 0) return undefined
  return { input, output, reasoning: 0, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

function numberToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function formatCharCount(value: number) {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}

// ---------------------------------------------------------------------------
// prompt assembly
// ---------------------------------------------------------------------------

export function claudeReadableDirectories(
  attachments: readonly FilePartInput[],
  targetDir: string,
  runDir: string,
): string[] {
  const externalDirectories = attachmentPaths(attachments)
    .filter((attachment) => attachment.isDirectory)
    .map((attachment) => attachment.path)
    .filter((directory) => !isWithin(directory, runDir) && !isWithin(directory, targetDir))
  return [runDir, ...new Set(externalDirectories)]
}

function attachmentPaths(attachments: readonly FilePartInput[]): { path: string; filename?: string; isDirectory: boolean }[] {
  const paths: { path: string; filename?: string; isDirectory: boolean }[] = []
  for (const part of attachments) {
    try {
      paths.push({
        path: fileURLToPath(part.url),
        ...(part.filename ? { filename: part.filename } : {}),
        isDirectory: part.mime === "application/x-directory",
      })
    } catch {
      // Non-file URLs can't be handed to the CLI as paths; skip them.
    }
  }
  return paths
}

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

/** Tees a Claude attempt's raw stream-json lines to an owner-only file (the shared raw stream log). */
export const ClaudeRawStreamLog = RawStreamLog

// ---------------------------------------------------------------------------
// post-step interactive resume ([o] on a finished claude-code step)
// ---------------------------------------------------------------------------

/**
 * Claude Code has no attachable live server: a session is a transcript on
 * disk, owned by one process at a time. While the step runs, the dashboard
 * already mirrors the stream; once the process has exited, `claude --resume`
 * reopens the transcript interactively with the step's full context.
 */
export async function openClaudeSessionWindow(input: { targetDir: string; sessionID: string; runDir: string }): Promise<SessionWindowBackend> {
  const readableDirectories = await readClaudeSessionDirectories(input.runDir, input.sessionID)
  const command = [claudeBinaryName, ...claudeResumeArgs(input.sessionID, readableDirectories)].map(shellQuote).join(" ")
  return openSessionCommand(command, input.targetDir, "claude session")
}

export function claudeResumeArgs(sessionID: string, readableDirectories: readonly string[]): string[] {
  return [...readOnlyToolArgs, "--add-dir", ...readableDirectories, "--resume", sessionID]
}

/** Records what a Claude session could read, so `[o]` reopens it with the same `--add-dir` set. */
export async function writeClaudeSessionDirectories(runDir: string, sessionID: string, directories: readonly string[]): Promise<void> {
  const logsDir = join(runDir, "logs")
  await mkdir(logsDir, { recursive: true })
  await writeFile(claudeSessionDirectoriesPath(runDir, sessionID), JSON.stringify(directories))
}

async function readClaudeSessionDirectories(runDir: string, sessionID: string): Promise<string[]> {
  const raw = await readFile(claudeSessionDirectoriesPath(runDir, sessionID), "utf8").catch((error: NodeJS.ErrnoException) => {
    // A session recorded before the engine wrote this file could read its run dir.
    if (error.code === "ENOENT") return JSON.stringify([runDir])
    throw error
  })
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((directory) => typeof directory !== "string" || directory.length === 0)) {
    throw new Error(`invalid readable-directory metadata for Claude session ${sessionID}`)
  }
  return parsed
}

function claudeSessionDirectoriesPath(runDir: string, sessionID: string): string {
  return join(runDir, "logs", `claude-${encodeURIComponent(sessionID)}-directories.json`)
}

/**
 * The shell prefix that gives an interactive Claude client the reviewed
 * billing source, as the headless adapter's overlay does: subscription drops
 * ambient API credentials so the operator's login is used, and api-key reads
 * the key from its named variable at launch. Only variable names are typed,
 * never a credential value, so nothing secret lands in argv or the pane.
 */
export function claudeAuthShellPrefix(auth: AuthenticationSelection = { mode: "subscription" }): string {
  if (auth.mode === "api-key") {
    const ref = auth.credentialRef
    if (!ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("Claude api-key mode needs credentialRef naming the variable that holds the key")
    return `unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_API_KEY="$${ref}"`
  }
  return "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;"
}

/**
 * Opens an interactive Claude session in the checkout for a human iteration
 * or authoring conversation: a normal Claude client with its own permission
 * prompts, under the reviewed authentication. `resume` reopens that exact
 * session; without it a fresh conversation starts.
 */
export async function openClaudeInteractiveWindow(input: { targetDir: string; auth?: AuthenticationSelection; resume?: string; label?: string; prompt?: string }): Promise<SessionWindowBackend> {
  const args = [claudeBinaryName, ...(input.resume ? ["--resume", input.resume] : []), ...(input.prompt ? [input.prompt] : [])].map(shellQuote).join(" ")
  return openSessionCommand(`${claudeAuthShellPrefix(input.auth)} ${args}`, input.targetDir, input.label ?? "claude session")
}

/** Runs an interactive Claude client in this terminal until it exits, under the reviewed authentication. */
export async function runInteractiveClaude(input: { targetDir: string; auth?: AuthenticationSelection; resume?: string }): Promise<number> {
  const resolution = resolveClaudeAuth({ selection: input.auth ?? { mode: "subscription" } })
  const proc = Bun.spawn([claudeBinaryName, ...(input.resume ? ["--resume", input.resume] : [])], {
    cwd: input.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: applyAuthOverlay(withoutHerdrEnv(process.env), resolution),
  })
  return proc.exited
}
