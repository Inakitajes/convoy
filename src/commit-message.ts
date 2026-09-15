import type { AgentConfig, Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { capSubjectWithin, firstMeaningfulLine, maxCommitSubjectLength } from "./commit-text"
import { log } from "./log"
import { startOpencode } from "./opencode"
import type { StopPolicy } from "./process-stop"
import { splitModelVariant } from "./pipeline"
import { parseModel } from "./runner"
import { excerpt } from "./worktree"

/**
 * Writes the conventional-commit message for the single commit automatic run compaction
 * squashes a run into. Built on the same shape as the branch namer: an
 * ephemeral opencode server running a registered read-only agent, a strict JSON
 * contract, and a deterministic fallback so a failure here never blocks the
 * commit — the user can always edit whatever comes back.
 */

export type ConventionalMessage = {
  type: string
  scope?: string
  subject: string
  /** Body lines, rendered as a bullet list under the subject. */
  body: string[]
}

export type CommitMessageInput = {
  targetDir: string
  /** The run's branch; its conventional prefix seeds the type when the model fails. */
  branch: string
  /** The run's PRD (prd.md). */
  prompt?: string
  /** The run's concatenated step reports (SUMMARY.md). */
  summary?: string
  /** The change's proposal document, snapshotted before archive moved it (close). */
  proposalExcerpt?: string
  /** The capability names the change's delta specs touch; the enforced scope rule's input (close). */
  scopeCandidates?: readonly string[]
  /** Subjects of the convoy commits being replaced, newest first. */
  commits: readonly string[]
  diffStat?: string
  /** Override the model that writes the message (provider/model[#variant]). */
  model?: string
  signal?: AbortSignal
  /**
   * Shared cleanup budget for the writer's owned helper (design D2). The
   * coordinator passes a resolver drawing from its remaining shutdown deadline
   * so this helper's stop cannot restart or exceed that budget.
   */
  stopPolicy?: () => StopPolicy
}

export type CommitMessageProposal = {
  message: ConventionalMessage
  source: "model" | "template"
  /** Set when the model call failed; surfaced so the user knows the message is a guess. */
  error?: string
}

/** Cheap, fast model used to write the squashed commit message (run compaction and `close` share it). */
export const defaultCommitMessageModel = "openai/gpt-5.6-luna"

/** Registered so the writer replaces opencode's default coding agent instead of merely appending to it. */
const writerAgentName = "convoy-commit-writer"

const commitMessageTimeoutMs = 60_000
/** Conventional commits recommend keeping the whole subject line inside ~72 columns. */
const maxSubjectLength = maxCommitSubjectLength
const maxBodyLines = 6

const commitTypes = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"] as const
const defaultCommitType = "feat"

type CommitMessageDeps = {
  startOpencode: typeof startOpencode
}

const defaultCommitMessageDeps: CommitMessageDeps = { startOpencode }

/** Same reasoning as the branch namer: a bare `system` string leaves opencode's chatty coding persona in charge. */
function writerOpencodeConfig(): Config {
  const agent: AgentConfig = {
    description: "Writes conventional-commit messages for convoy runs",
    mode: "primary",
    temperature: 0,
    prompt: commitMessageSystemPrompt,
    tools: {
      read: true,
      list: true,
      glob: true,
      grep: true,
      webfetch: false,
      write: false,
      edit: false,
      bash: false,
      task: false,
      todoread: false,
      todowrite: false,
      websearch: false,
    },
    permission: {
      read: "allow",
      list: "allow",
      glob: "allow",
      grep: "allow",
      webfetch: "deny",
      edit: "deny",
      bash: "deny",
      task: "deny",
      question: "deny",
      websearch: "deny",
    },
  }
  return {
    agent: { [writerAgentName]: agent },
    permission: { question: "deny" },
  }
}

/**
 * Asks a cheap, read-only model to describe the run as one conventional commit.
 * Any failure (no auth, timeout, unparseable reply) degrades to a message built
 * from the branch name and the step commits, so compaction always has something
 * to show.
 */
export async function proposeCommitMessage(
  input: CommitMessageInput,
  deps: CommitMessageDeps = defaultCommitMessageDeps,
): Promise<CommitMessageProposal> {
  let error: string | undefined
  try {
    const handle = await deps.startOpencode(
      writerOpencodeConfig(),
      AbortSignal.timeout(commitMessageTimeoutMs),
      // A helper under a coordinator gets its shared budget resolver so its
      // bounded stop draws from the coordinator's remaining deadline.
      input.stopPolicy ? { stopPolicy: input.stopPolicy } : undefined,
    )
    try {
      const reply = await askForCommitMessage(handle.client, { ...input, model: input.model ?? defaultCommitMessageModel })
      const message = readCommitMessage(reply)
      if (message) return { message, source: "model" }
      error = `the commit writer's reply had no usable message: ${truncate(reply, 160)}`
    } finally {
      await handle.close()
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  log.warn(`compaction: couldn't generate an AI commit message (${error}); deriving one from the branch and the step commits`)
  return { message: templateCommitMessage(input), source: "template", error }
}

export async function askForCommitMessage(client: OpencodeClient, input: CommitMessageInput & { model: string }): Promise<string> {
  const parsedModel = splitModelVariant(input.model)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("commit writer timed out")), commitMessageTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let sessionID: string | undefined
  try {
    const session = await client.session.create({ directory: input.targetDir, title: "convoy commit writer" }, { signal: controller.signal })
    if (session.error || !session.data?.id) throw new Error("couldn't open a commit message session")
    sessionID = session.data.id

    const response = await client.session.prompt(
      {
        sessionID,
        directory: input.targetDir,
        model: parseModel(parsedModel.model),
        ...(parsedModel.variant ? { variant: parsedModel.variant } : {}),
        agent: writerAgentName,
        // Sent as well as the agent prompt so an unresolved agent name still
        // yields the contract rather than a free-form answer.
        system: commitMessageSystemPrompt,
        tools: { read: true, list: true, glob: true, grep: true, webfetch: false, write: false, edit: false, bash: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: commitMessagePrompt(input) }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("commit writer returned no answer")
    return collectText(response.data.parts)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: input.targetDir })
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * What the run actually was, in the order that matters: the reports say what got
 * built, the PRD says what was asked for, and the step commits/diffstat are
 * corroboration. All excerpted — a long PRD plus six reports would otherwise
 * dwarf the useful signal.
 */
export function commitMessagePrompt(input: CommitMessageInput): string {
  const parts: string[] = [`Branch: ${input.branch}`]
  if (input.summary?.trim()) parts.push(`What the run reported doing:\n${excerpt(input.summary.trim())}`)
  if (input.proposalExcerpt?.trim()) parts.push(`The change's proposal document:\n${excerpt(input.proposalExcerpt.trim())}`)
  if (input.prompt?.trim()) parts.push(`What the user originally asked for:\n${excerpt(input.prompt.trim())}`)
  if (input.scopeCandidates && input.scopeCandidates.length > 0) {
    parts.push(`Touched capabilities: ${input.scopeCandidates.join(", ")}`)
    if (input.scopeCandidates.length === 1) {
      parts.push(`Use "${input.scopeCandidates[0]}" as the scope — the change touches exactly one capability.`)
    } else {
      parts.push("The change touches several capabilities, so omit the scope entirely.")
    }
  }
  if (input.commits.length > 0) parts.push(`The step commits being squashed:\n${input.commits.map((subject) => `- ${subject}`).join("\n")}`)
  if (input.diffStat?.trim()) parts.push(`Diffstat:\n${excerpt(input.diffStat.trim())}`)
  return parts.join("\n\n")
}

const commitMessageSystemPrompt = [
  "You write git commit messages. You are given everything an automated multi-step coding run did on one",
  "branch; describe it as ONE conventional commit. Reply with nothing but a single line of JSON:",
  '{"type": "feat", "scope": "advisor", "subject": "add per-step advisor model", "body": ["...", "..."]}',
  "",
  `"type" is one of: ${commitTypes.join(", ")}.`,
  '"scope" is optional: one lowercase word for the area touched, or omit it when the change is broad.',
  `"subject" is imperative mood, lowercase, no trailing period, and short enough that "type(scope): subject" fits in ${maxSubjectLength} characters.`,
  `"body" is an array of at most ${maxBodyLines} short strings, each one concrete change. Omit it (or use []) for a trivial change.`,
  "",
  "Rules:",
  "- Describe what the change DOES to the codebase, from the reports and the diffstat. Never mention convoy,",
  "  the pipeline, the steps, the agents, or the fact that this was generated.",
  '- Never write process narration like "implemented the plan" or "addressed review feedback".',
  "- Always write in ENGLISH, even when the prompt and reports are in another language.",
  "- Never ask the user anything. There is no follow-up turn; a question is a failed answer.",
  "- You may read files in the repo before answering, but the LAST line of your reply must be the JSON",
  "  object and nothing else.",
].join("\n")

/**
 * Pulls the message out of the writer's reply. The JSON object is the contract;
 * scanning from the last line backwards (then the whole reply) tolerates a model
 * that investigated and narrated before answering.
 */
export function readCommitMessage(raw: string): ConventionalMessage | undefined {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseMessageObject(lines[index]!)
    if (parsed) return parsed
  }
  // A fenced or pretty-printed object spans several lines; try the whole reply.
  return parseMessageObject(raw)
}

function parseMessageObject(text: string): ConventionalMessage | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined

  const record = parsed as { type?: unknown; scope?: unknown; subject?: unknown; body?: unknown }
  const subject = cleanSubject(typeof record.subject === "string" ? record.subject : "")
  if (!subject) return undefined

  const type = normalizeType(typeof record.type === "string" ? record.type : "")
  const scope = cleanScope(typeof record.scope === "string" ? record.scope : "")
  const body = Array.isArray(record.body)
    ? record.body
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.trim().replace(/^[-*]\s*/, ""))
        .filter(Boolean)
        .slice(0, maxBodyLines)
    : []

  return { type, ...(scope ? { scope } : {}), subject: capSubject(type, scope, subject), body }
}

/** The deterministic message: type/scope from the branch, subject from the prompt, body from the step commits. */
export function templateCommitMessage(input: CommitMessageInput): ConventionalMessage {
  const { type, rest } = splitBranch(input.branch)
  const fromPrompt = cleanSubject(firstMeaningfulLine(input.prompt ?? ""))
  const subject = fromPrompt || cleanSubject(rest.replace(/-/g, " ")) || "update"
  // Step commits read "convoy(implementer): Implementer report"; the scope is
  // the step name, which says nothing about the change, so only the summary
  // survives into the body.
  const body = input.commits
    .map((line) => line.replace(/^convoy\([^)]*\):\s*/, "").trim())
    .filter(Boolean)
    .slice(0, maxBodyLines)
  return { type, subject: capSubject(type, undefined, subject), body }
}

/**
 * Enforces the close capability's scope rule on a writer's proposal (design D1):
 * exactly one touched capability becomes the scope, zero or several remove it.
 * The change id is injected into the body of a composed message — the subject
 * never carries the slug. The model proposes; this decides.
 */
export function normalizeComposedMessage(
  message: ConventionalMessage,
  opts: { scopeCandidates?: readonly string[]; changeID?: string } = {},
): ConventionalMessage {
  const candidates = opts.scopeCandidates ?? []
  const scope = candidates.length === 1 ? cleanScope(candidates[0]!) || undefined : undefined
  let body = message.body
  // Skip only when the id is named the way this rule names it ("change <id>"),
  // not when a collapsed commit subject merely happens to contain the id.
  if (opts.changeID && !body.some((line) => line === `change ${opts.changeID}`)) {
    body = [`change ${opts.changeID}`, ...body]
  }
  body = body.slice(0, maxBodyLines)
  return {
    type: message.type,
    ...(scope ? { scope } : {}),
    subject: capSubject(message.type, scope, message.subject),
    body,
  }
}

/**
 * Type-appropriate imperative verbs for the deterministic close fallback
 * (design D1); anything not listed updates.
 */
const closeFallbackVerbs: Record<string, string> = {
  feat: "improve",
  perf: "improve",
  fix: "fix",
  refactor: "refactor",
  docs: "document",
  test: "test",
}

/**
 * The deterministic close fallback: the branch prefix as type (`change/`
 * branches keep their spin-specific prefix, like close's own branchPrefix),
 * the same sole-capability scope rule, an imperative verb plus the normalized
 * proposal title, the change id first in the body, then the collapsed step
 * commits. Used when the writer model answers nothing usable.
 */
export function closeFallbackCommitMessage(input: {
  branch: string
  proposal?: string
  changeID?: string
  scopeCandidates?: readonly string[]
  commits?: readonly string[]
}): ConventionalMessage {
  const { type, rest } = splitCloseBranch(input.branch)
  const verb = closeFallbackVerbs[type] ?? "update"
  const title = cleanSubject(firstMeaningfulLine(input.proposal ?? "")).toLowerCase()
  const slug = cleanSubject(rest.replace(/-/g, " "))
  const subject = title ? `${verb} ${title}` : slug ? `${verb} ${slug}` : "update"
  const body = (input.commits ?? [])
    .map((line) => line.replace(/^convoy\([^)]*\):\s*/, "").trim())
    .filter(Boolean)
    .slice(0, maxBodyLines)
  return normalizeComposedMessage({ type, subject, body }, {
    scopeCandidates: input.scopeCandidates,
    ...(input.changeID ? { changeID: input.changeID } : {}),
  })
}

/** Like splitBranch, but `change` (spin's all-modified prefix) is a valid close type. */
function splitCloseBranch(branch: string): { type: string; rest: string } {
  const match = /^([a-z]+)\/(.+)$/i.exec(branch.trim())
  if (!match) return { type: defaultCommitType, rest: branch.trim() }
  const prefix = match[1]!.toLowerCase()
  const type = (commitTypes as readonly string[]).includes(prefix) || prefix === "change" ? prefix : defaultCommitType
  return { type, rest: match[2]! }
}

/** Renders the message as git receives it: subject line, blank line, bullet body. */
export function formatCommitMessage(message: ConventionalMessage): string {
  const scope = message.scope ? `(${message.scope})` : ""
  const subject = `${message.type}${scope}: ${message.subject}`
  if (message.body.length === 0) return subject
  return `${subject}\n\n${message.body.map((line) => `- ${line}`).join("\n")}`
}

function splitBranch(branch: string): { type: string; rest: string } {
  const match = /^([a-z]+)\/(.+)$/i.exec(branch.trim())
  if (!match) return { type: defaultCommitType, rest: branch.trim() }
  return { type: normalizeType(match[1]!), rest: match[2]! }
}

function normalizeType(value: string): string {
  const lowered = value.trim().toLowerCase()
  return (commitTypes as readonly string[]).includes(lowered) ? lowered : defaultCommitType
}

function cleanScope(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 20)
}

function cleanSubject(value: string): string {
  return value
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    // A model that ignored the contract sometimes answers with the whole
    // "type(scope): subject" line; keep only the subject so it isn't doubled.
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim()
}

function capSubject(type: string, scope: string | undefined, subject: string): string {
  return capSubjectWithin(`${type}${scope ? `(${scope})` : ""}: `, subject)
}

function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
