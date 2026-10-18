/**
 * The subset of the Codex app-server protocol (JSON-RPC over stdio) the Codex
 * adapter speaks (change `add-codex-runner`, design D1).
 *
 * Hand-written from `codex app-server generate-json-schema` at the minimum
 * supported Codex version (`declarations.ts`); only the fields Convoy reads or
 * sends are typed, and every read is defensive, since the protocol is labeled
 * experimental upstream.
 */

export type JsonRpcId = string | number

export type JsonRpcMessage = {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh"

export type ThreadStartParams = {
  cwd: string
  model?: string
  approvalPolicy: "untrusted" | "on-request" | "never"
  sandbox: CodexSandboxMode
  developerInstructions?: string
  ephemeral?: boolean
  config?: Record<string, unknown>
  serviceName?: string
}

export type TurnStartParams = {
  threadId: string
  input: { type: "text"; text: string }[]
  effort?: CodexReasoningEffort
  outputSchema?: Record<string, unknown>
}

/** A thread item, as `item/started` and `item/completed` carry it. */
export type CodexItem = {
  type: string
  id: string
  text?: string
  phase?: string
  command?: string
  cwd?: string
  status?: string
  exitCode?: number | null
  aggregatedOutput?: string | null
  changes?: { path: string; kind?: { type?: string }; diff?: string }[]
  server?: string
  tool?: string
  arguments?: unknown
  error?: unknown
  summary?: string[]
  content?: string[]
}

export type TokenUsageBreakdown = {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

export type AccountInfo =
  | { type: "chatgpt"; planType?: string }
  | { type: "apiKey" }
  | { type: string; [key: string]: unknown }

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}
