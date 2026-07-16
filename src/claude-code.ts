import { copyFile, mkdir, open, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { FilePartInput } from "@opencode-ai/sdk/v2"

import { loadAgentPrompt } from "./agents"
import { log } from "./log"
import { openSessionCommand, shellQuote, type SessionWindowBackend } from "./opencode"
import type { ProgressMessage, ProgressTokens, ProgressUI } from "./progress"
import { stepRunnerFor } from "./step-runners"
import type { AgentStep, Pipeline } from "./types"
import type { Workspace } from "./workspace"

/**
 * Runner for `runner: claude-code` steps: spawns the user's local `claude`
 * CLI headless instead of an OpenCode session. Authentication is whatever
 * that install already uses (subscription login or ANTHROPIC_API_KEY), so
 * Archer never touches credentials. v1 supports read-only audit steps only —
 * the CLI runs with read/search tools exclusively, and the report is the
 * final assistant text, persisted by Archer like any other read-only step.
 */

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

/**
 * Fail-fast dependency check: Claude Code is optional — only a pipeline that
 * actually contains a claude-code step requires the CLI, and it must fail at
 * launch, never minutes into a run.
 */
export function ensureClaudeAvailable(pipeline: Pipeline, which: (bin: string) => string | null = Bun.which) {
  if (!pipelineUsesClaudeCode(pipeline)) return
  if (which(claudeBinaryName)) return
  const steps = pipeline.steps
    .filter((step) => step.type === "agent" && step.runner === "claude-code")
    .map((step) => step.name)
    .join(", ")
  throw new Error(
    `pipeline "${pipeline.name}" uses runner: claude-code (steps: ${steps}) but the \`claude\` CLI was not found in PATH; install Claude Code (https://code.claude.com) or remove those steps`,
  )
}

/** Display label for attempt lines and usage rows, mirroring provider/model formatting. */
export function claudeModelLabel(model: string): string {
  return stepRunnerFor("claude-code").modelLabel(model)
}

// ---------------------------------------------------------------------------
// stream-json → Archer signals
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
}

export function newClaudeStreamState(): ClaudeStreamState {
  return { reasoningChars: 0, textChars: 0 }
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
    const delta = deltaOf(record.event)
    if (!delta) return []
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      state.textChars += delta.text.length
      return [
        { type: "message", message: { channel: "response", text: delta.text } },
        { type: "activity", message: `responding… (${formatCharCount(state.textChars)} chars)`, kind: "write", pulse: true },
      ]
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      state.reasoningChars += delta.thinking.length
      return [
        { type: "message", message: { channel: "reasoning", text: delta.thinking } },
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

/**
 * OpenCode receives attachments as file parts; the claude CLI receives the
 * same files as absolute paths listed in the prompt, readable thanks to
 * --add-dir on the run workspace (the exact mirror of the OpenCode read-only
 * agents' external_directory allow rule).
 */
export function claudePrompt(basePrompt: string, attachments: readonly FilePartInput[]): string {
  const paths = attachmentPaths(attachments)

  if (paths.length === 0) return basePrompt

  return [
    basePrompt,
    "",
    "## Attached files",
    "This runner delivers attachments as files on disk instead of inline parts. Read each of these before acting:",
    ...paths.map((entry) => `- ${entry.path}${entry.filename && !entry.path.endsWith(entry.filename) ? ` (${entry.filename})` : ""}`),
  ].join("\n")
}

export function claudeArgs(input: {
  systemPromptPath: string
  runDir: string
  targetDir: string
  model: string
  attachments: readonly FilePartInput[]
}): string[] {
  const readableDirectories = claudeReadableDirectories(input.attachments, input.targetDir, input.runDir)

  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt-file",
    input.systemPromptPath,
    "--add-dir",
    ...readableDirectories,
    ...readOnlyToolArgs,
    ...(input.model ? ["--model", input.model] : []),
  ]
}

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

export async function stageClaudeAttachments(
  attachments: readonly FilePartInput[],
  targetDir: string,
  runDir: string,
  stageDir: string,
): Promise<FilePartInput[]> {
  const staged: FilePartInput[] = []
  for (const [index, attachment] of attachments.entries()) {
    const [details] = attachmentPaths([attachment])
    if (!details || details.isDirectory || isWithin(details.path, targetDir) || isWithin(details.path, runDir)) {
      staged.push(attachment)
      continue
    }
    await mkdir(stageDir, { recursive: true })
    const stagedPath = join(stageDir, `${index}-${basename(details.path)}`)
    await copyFile(details.path, stagedPath)
    staged.push({ ...attachment, url: pathToFileURL(stagedPath).href })
  }
  return staged
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** The subset of runner.ts' RunShutdown this module needs (structural, to avoid an import cycle). */
export type ClaudeShutdown = {
  signal: AbortSignal
  aborted: boolean
  throwIfRequested(): void
  abortError(fallback?: unknown): Error
}

export type ClaudePhaseResult = {
  assistantText: string
  sessionID?: string
  cost?: number
  tokens?: ProgressTokens
  finish?: string
  error?: string
}

type ClaudeProcess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  exitCode: number | null
  kill(): void
}

export type ClaudeExecutionDeps = {
  spawn(command: string[], options: { cwd: string; stdin: Blob; stdout: "pipe"; stderr: "pipe" }): ClaudeProcess
  stageAttachments: typeof stageClaudeAttachments
}

const defaultClaudeExecutionDeps: ClaudeExecutionDeps = {
  spawn: (command, options) => Bun.spawn(command, options),
  stageAttachments: stageClaudeAttachments,
}

export async function promptClaudePhase(input: {
  phase: AgentStep
  workspace: Workspace
  targetDir: string
  prompt: string
  attachments: readonly FilePartInput[]
  attempt: number
  progress: ProgressUI
  shutdown: ClaudeShutdown
  sessionRef?: { id?: string }
  deps?: ClaudeExecutionDeps
}): Promise<ClaudePhaseResult> {
  input.shutdown.throwIfRequested()
  const deps = input.deps ?? defaultClaudeExecutionDeps

  const systemPrompt = loadAgentPrompt(baseAgentName(input.phase.agentName), input.targetDir)
  const systemPromptPath = await writeClaudeSystemPrompt(input.workspace, input.phase, input.attempt, systemPrompt)
  const stageDir = join(input.workspace.dir, "attachments", encodeURIComponent(input.phase.name), String(input.attempt))
  const attachments = await deps.stageAttachments(input.attachments, input.targetDir, input.workspace.dir, stageDir)
  const readableDirectories = claudeReadableDirectories(attachments, input.targetDir, input.workspace.dir)
  const args = claudeArgs({
    systemPromptPath,
    runDir: input.workspace.dir,
    targetDir: input.targetDir,
    model: input.phase.model,
    attachments,
  })
  const prompt = claudePrompt(input.prompt, attachments)

  const proc = deps.spawn([claudeBinaryName, ...args], {
    cwd: input.targetDir,
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  })

  const kill = () => proc.kill()
  input.shutdown.signal.addEventListener("abort", kill, { once: true })
  if (input.shutdown.signal.aborted) kill()
  // Drain stderr immediately so a noisy hook/plugin cannot fill the pipe and
  // deadlock the child while stdout is still streaming.
  const stderrPromise = new Response(proc.stderr).text()

  const state = newClaudeStreamState()
  const rawLog = claudeRawStreamLog(input.workspace, input.phase, input.attempt)
  let sessionID: string | undefined
  let result: ClaudeSignal & { type: "result" } | undefined

  try {
    for await (const line of ndjsonLines(proc.stdout)) {
      await rawLog.append(line)
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue // partial writes or non-JSON noise never kill the run
      }
      for (const signal of describeClaudeEvent(event, state)) {
        if (signal.type === "session") {
          sessionID = signal.sessionID
          await writeClaudeSessionDirectories(input.workspace.dir, signal.sessionID, readableDirectories)
          if (input.sessionRef) input.sessionRef.id = signal.sessionID
          input.progress.phaseSession(input.phase.name, signal.sessionID)
          log.info(`[${input.phase.name}] claude session: ${signal.sessionID}`)
        } else if (signal.type === "message") {
          input.progress.phaseMessage(input.phase.name, signal.message)
        } else if (signal.type === "activity") {
          input.progress.phaseActivity(input.phase.name, signal.message, signal.kind, signal.pulse)
        } else {
          result = signal
        }
      }
    }

    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise])
    input.shutdown.throwIfRequested()

    if (result) {
      if (result.cost !== undefined || result.tokens) {
        input.progress.phaseUsageTotal(input.phase.name, {
          ...(sessionID ? { sessionID } : {}),
          ...(result.cost !== undefined ? { cost: result.cost } : {}),
          ...(result.tokens ? { tokens: result.tokens } : {}),
          model: claudeModelLabel(input.phase.model),
        })
      }
      return {
        assistantText: result.text,
        ...(sessionID ? { sessionID } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.tokens ? { tokens: result.tokens } : {}),
        finish: result.subtype,
        ...(result.isError ? { error: `claude exited with ${result.subtype}${result.text ? `: ${truncate(result.text, 300)}` : ""}` } : {}),
      }
    }

    const detail = stderr.trim().split("\n").slice(-3).join(" ").trim()
    throw new Error(`claude exited with status ${exitCode} before reporting a result${detail ? `: ${detail}` : ""}`)
  } catch (error) {
    if (input.shutdown.aborted) throw input.shutdown.abortError(error)
    throw error
  } finally {
    await rawLog.close()
    input.shutdown.signal.removeEventListener("abort", kill)
    if (proc.exitCode === null) proc.kill()
  }
}

async function writeClaudeSystemPrompt(workspace: Workspace, phase: AgentStep, attempt: number, contents: string): Promise<string> {
  const directory = join(workspace.dir, "prompts")
  const path = join(directory, `${encodeURIComponent(phase.name)}.${attempt}.claude.md`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, contents, { mode: 0o600 })
  return path
}

/** Synthesized read-only variants ("agent__ro") share the base agent's prompt file. */
function baseAgentName(agentName: string): string {
  return agentName.endsWith("__ro") ? agentName.slice(0, -"__ro".length) : agentName
}

function claudeRawStreamLog(workspace: Workspace, phase: AgentStep, attempt: number) {
  const path = join(workspace.dir, "logs", `${phase.name}.${attempt}.claude.jsonl`)
  return new ClaudeRawStreamLog(path, phase.name)
}

class ClaudeRawStreamLog {
  private file: Awaited<ReturnType<typeof open>> | undefined
  private failed = false

  constructor(private readonly path: string, private readonly phaseName: string) {}

  async append(line: string) {
    if (this.failed) return
    try {
      const file = await this.openFile()
      await file.write(`${line}\n`)
    } catch (error) {
      await this.fail(error)
    }
  }

  async close() {
    try {
      await this.file?.close()
      this.file = undefined
    } catch (error) {
      await this.fail(error)
    }
  }

  private async openFile() {
    if (this.file) return this.file
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    this.file = await open(this.path, "w", 0o600)
    await this.file.chmod(0o600)
    return this.file
  }

  private async fail(error: unknown) {
    if (this.failed) return
    this.failed = true
    await this.file?.close().catch(() => undefined)
    this.file = undefined
    log.warn(`[${this.phaseName}] couldn't write claude stream log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) yield trimmed
    }
  }
  const tail = (buffer + decoder.decode()).trim()
  if (tail) yield tail
}

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
  return openSessionCommand(command, input.targetDir)
}

export function claudeResumeArgs(sessionID: string, readableDirectories: readonly string[]): string[] {
  return [...readOnlyToolArgs, "--add-dir", ...readableDirectories, "--resume", sessionID]
}

async function writeClaudeSessionDirectories(runDir: string, sessionID: string, directories: readonly string[]): Promise<void> {
  const logsDir = join(runDir, "logs")
  await mkdir(logsDir, { recursive: true })
  await writeFile(claudeSessionDirectoriesPath(runDir, sessionID), JSON.stringify(directories))
}

async function readClaudeSessionDirectories(runDir: string, sessionID: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(claudeSessionDirectoriesPath(runDir, sessionID), "utf8"))
  if (!Array.isArray(parsed) || parsed.some((directory) => typeof directory !== "string" || directory.length === 0)) {
    throw new Error(`invalid readable-directory metadata for Claude session ${sessionID}`)
  }
  return parsed
}

function claudeSessionDirectoriesPath(runDir: string, sessionID: string): string {
  return join(runDir, "logs", `claude-${encodeURIComponent(sessionID)}-directories.json`)
}
