import type { OpencodeClient } from "./opencode-client"

import { log } from "./log"
import type { AuthenticationSelection } from "./runners/contracts"
import { helperInferenceFor, type HelperInferenceSeams } from "./runners/helper-inference"
import { runnerOfModelReference } from "./step-runners"

/** An external classifier's call on whether a permission request is safe to auto-approve. */
export type SafetyVerdict = { safe: boolean; reason: string }

export type JudgeRequest = {
  permission: string
  command?: string
  target?: string
  description?: string
  patterns?: string[]
}

export type JudgeInput = {
  request: JudgeRequest
  /**
   * The judge route's model. A runner-qualified route (`providerID` naming a
   * CLI runner, as `claude-code/<model>` or `codex/<model>`) judges through
   * that runner's CLI under `auth`, so a Claude- or Codex-only install needs
   * no OpenCode; any other provider judges on the run's OpenCode server. The
   * OpenCode prompt body accepts providerID/modelID only — no variant.
   */
  model: { providerID: string; modelID: string; variant?: string }
  directory: string
  signal?: AbortSignal
  /** Override for the per-request budget; defaults to 20s. */
  timeoutMs?: number
  /** The reviewed authentication for a CLI-routed judge; defaults to subscription. */
  auth?: AuthenticationSelection
  /** Test seams for the CLI runners. */
  inferenceSeams?: HelperInferenceSeams
}

/** True when the judge route runs on a CLI runner rather than an OpenCode server. */
export function isCliJudge(model: { providerID: string }): boolean {
  return helperInferenceFor(runnerOfModelReference(model)) !== undefined
}

const defaultTimeoutMs = 20_000
const defaultExplainTimeoutMs = 45_000

/**
 * The judge runs OUTSIDE the agentic loop: a single stateless prompt with every
 * tool disabled, so it can only classify — never act. It is deliberately
 * fail-closed: any error, timeout, or unparseable answer returns `safe: false`
 * so the request escalates to the human instead of being waved through.
 */
const judgeSystemPrompt = [
  "You are a security gatekeeper for an autonomous coding agent. You decide whether a single",
  "tool/command request may be auto-approved WITHOUT human review. You cannot run anything;",
  "you only classify.",
  "",
  "Mark it SAFE only when it is read-only or clearly reversible and local, with no access to",
  "secrets/credentials, no exfiltration of data to external hosts, and no destructive or",
  "irreversible effect. Examples of SAFE: reading or listing files, running tests, type-checks,",
  "linters, git status/diff/log, builds confined to the workspace.",
  "",
  "Mark it UNSAFE (requires a human) when it is destructive or irreversible (rm -rf, git push",
  "--force, resetting/dropping/altering data stores or remote state), installs or modifies",
  "global/system configuration, sends data to external hosts (curl/wget POST, scp, uploads),",
  "reads credentials/secrets/keys, or is ambiguous enough that you are not confident.",
  "",
  "When in doubt, choose UNSAFE. Reply with STRICT JSON and nothing else:",
  '{"safe": boolean, "reason": "<short explanation, <=140 chars>"}',
].join("\n")

/**
 * System prompt for the deep-explain mode: two short paragraphs asking the judge
 * to describe what the command does and why it is risky, in plain prose.
 */
const explainSystemPrompt = [
  "You are a safety judge explaining a permission request to a human. Describe what the command",
  "actually does and what makes it risky. Be specific: mention the concrete risk (data loss,",
  "exfiltration, credential exposure, destructive side effect) and what would make it safe or not.",
  "",
  "Keep your answer to at most 120 words. Use plain text, no markdown, no code fences.",
].join("\n")

/**
 * Shared setup/teardown for a judge session: creates a throwaway session, sends
 * a prompt, and collects the text response. The session is always deleted
 * (best-effort) in the finally block. Throws on error or timeout.
 */
async function runJudgeSession(
  client: OpencodeClient | undefined,
  input: {
    directory: string
    model: { providerID: string; modelID: string; variant?: string }
    system: string
    text: string
    signal?: AbortSignal
    timeoutMs: number
    auth?: AuthenticationSelection
    inferenceSeams?: HelperInferenceSeams
  },
): Promise<string> {
  const infer = helperInferenceFor(runnerOfModelReference(input.model), input.inferenceSeams)
  if (infer) {
    // Tool-less, one-shot, under the reviewed auth: it can only classify.
    const answer = await infer({
      prompt: input.text,
      system: input.system,
      model: input.model.modelID,
      ...(input.model.variant ? { variant: input.model.variant } : {}),
      auth: input.auth ?? { mode: "subscription" },
      cwd: input.directory,
      tools: "none",
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch((error: unknown) => {
      throw new Error(error instanceof Error && error.message.endsWith("timed out") ? "safety judge timed out" : error instanceof Error ? error.message : String(error))
    })
    return answer.text
  }
  if (!client) throw new Error(`no OpenCode server is running for the ${input.model.providerID}/${input.model.modelID} judge`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("safety judge timed out")), input.timeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let sessionID: string | undefined
  try {
    const session = await client.session.create(
      {
        directory: input.directory,
        title: "convoy safety judge",
        // V2 has no per-prompt `tools` map: a tool-less judge must deny every
        // action at session creation. Denying only specific tools is not enough
        // — a model can fall back to another (e.g. shell after `read`).
        // Validated against a real V2 server: `action: "*"` blocks all tools.
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
      { signal: controller.signal },
    )
    if (session.error || !session.data?.id) throw new Error("safety judge couldn't open a session")
    sessionID = session.data.id

    const response = await client.session.prompt(
      {
        sessionID,
        directory: input.directory,
        model: { providerID: input.model.providerID, modelID: input.model.modelID },
        system: input.system,
        // Every tool off: the judge classifies, it never executes.
        tools: { read: false, write: false, edit: false, bash: false, webfetch: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: input.text }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("safety judge returned no answer")

    return collectText(response.data.parts)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: input.directory })
      } catch {
        // ignore
      }
    }
  }
}

export async function judgeCommand(client: OpencodeClient | undefined, input: JudgeInput): Promise<SafetyVerdict> {
  try {
    const text = await runJudgeSession(client, {
      directory: input.directory,
      model: input.model,
      system: judgeSystemPrompt,
      text: renderRequest(input.request),
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
      ...(input.auth ? { auth: input.auth } : {}),
      ...(input.inferenceSeams ? { inferenceSeams: input.inferenceSeams } : {}),
    })
    const verdict = parseVerdict(text)
    if (!verdict) {
      log.warn(`[safety-judge] unparseable verdict, escalating: ${truncate(text, 160)}`)
      return { safe: false, reason: "could not read the safety verdict" }
    }
    return verdict
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`[safety-judge] evaluation failed, escalating: ${message}`)
    return { safe: false, reason: `safety check failed (${message})` }
  }
}

export type ExplainInput = JudgeInput & {
  /** The verdict reason that escalated this request, when smart mode produced one. */
  verdictReason?: string
}

/**
 * Asks the judge for a prose explanation of the permission request and its risk.
 * Unlike `judgeCommand`, this is not fail-closed: on error or timeout it returns
 * a human-readable fallback string instead of throwing.
 */
export async function explainCommand(client: OpencodeClient | undefined, input: ExplainInput): Promise<string> {
  try {
    const text = await runJudgeSession(client, {
      directory: input.directory,
      model: input.model,
      system: explainSystemPrompt,
      text: renderRequest(input.request, input.verdictReason),
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? defaultExplainTimeoutMs,
      ...(input.auth ? { auth: input.auth } : {}),
      ...(input.inferenceSeams ? { inferenceSeams: input.inferenceSeams } : {}),
    })
    return text || "the judge returned an empty explanation"
  } catch (error) {
    if (error instanceof Error && error.message === "safety judge timed out") {
      return "the judge could not explain it (timed out)"
    }
    return `the judge could not explain it (${error instanceof Error ? error.message : String(error)})`
  }
}

function renderRequest(request: JudgeRequest, verdictReason?: string): string {
  const lines = [`category: ${request.permission}`]
  if (request.command) lines.push(`command: ${request.command}`)
  if (request.target) lines.push(`target: ${request.target}`)
  if (request.patterns && request.patterns.length > 0) lines.push(`patterns: ${request.patterns.join(", ")}`)
  if (request.description) lines.push(`description: ${request.description}`)
  lines.push("", "Is it safe to auto-approve this without human review?")
  if (verdictReason) lines.push("", `The safety judge previously escalated this request with this reason: ${verdictReason}`)
  return lines.join("\n")
}

function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

/**
 * Pulls the verdict out of the model's reply: tolerates code fences and prose
 * around the JSON, but returns undefined (→ fail-closed) on anything it can't
 * confidently read as `{ safe, reason }`.
 */
export function parseVerdict(text: string): SafetyVerdict | undefined {
  if (!text) return undefined
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
  const safe = (parsed as { safe?: unknown }).safe
  if (typeof safe !== "boolean") return undefined
  const rawReason = (parsed as { reason?: unknown }).reason
  const reason = typeof rawReason === "string" && rawReason.trim().length > 0 ? rawReason.trim() : safe ? "judged safe" : "judged unsafe"
  return { safe, reason: truncate(reason, 200) }
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}
