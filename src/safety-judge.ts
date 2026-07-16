import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { log } from "./log"

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
  /** The prompt body accepts providerID/modelID only — no variant. */
  model: { providerID: string; modelID: string }
  directory: string
  signal?: AbortSignal
  /** Override for the per-request budget; defaults to 20s. */
  timeoutMs?: number
}

const defaultTimeoutMs = 20_000

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

export async function judgeCommand(client: OpencodeClient, input: JudgeInput): Promise<SafetyVerdict> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("safety judge timed out")), input.timeoutMs ?? defaultTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let sessionID: string | undefined
  try {
    const session = await client.session.create(
      { directory: input.directory, title: "convoy safety judge" },
      { signal: controller.signal },
    )
    if (session.error || !session.data?.id) throw new Error("safety judge couldn't open a session")
    sessionID = session.data.id

    const response = await client.session.prompt(
      {
        sessionID,
        directory: input.directory,
        model: input.model,
        system: judgeSystemPrompt,
        // Every tool off: the judge classifies, it never executes.
        tools: { read: false, write: false, edit: false, bash: false, webfetch: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: renderRequest(input.request) }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("safety judge returned no answer")

    const text = collectText(response.data.parts)
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
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    // Throwaway session; the run workspace is ephemeral, so deletion is best-effort.
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: input.directory })
      } catch {
        // ignore
      }
    }
  }
}

function renderRequest(request: JudgeRequest): string {
  const lines = [`category: ${request.permission}`]
  if (request.command) lines.push(`command: ${request.command}`)
  if (request.target) lines.push(`target: ${request.target}`)
  if (request.patterns && request.patterns.length > 0) lines.push(`patterns: ${request.patterns.join(", ")}`)
  if (request.description) lines.push(`description: ${request.description}`)
  lines.push("", "Is it safe to auto-approve this without human review?")
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
