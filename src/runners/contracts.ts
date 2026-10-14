/**
 * Runner contracts (change `runner-parity-opencode-v2`, design D1).
 *
 * These types are Convoy-owned. They describe what the orchestration core needs
 * from *any* harness without naming a vendor: the request core hands to an
 * adapter, the observations an attempt emits back, the terminal outcome, and the
 * capability description used to gate features.
 *
 * IMPORTANT: no vendor type may appear here (no `OpencodeClient`, no vendor
 * message part, no SDK callback). Adapters translate their native protocol into
 * this vocabulary; protocol changes land inside an adapter, not across the core.
 */

import type { StepRunnerId } from "../step-runners"

/** Re-exported so core code can name a runner without reaching into a vendor. */
export type RunnerId = StepRunnerId

/** A runner-qualified session reference. The native id is opaque to the core. */
export type RunnerSessionRef = {
  runner: RunnerId
  /** Native, harness-issued session identifier. Never parsed by Convoy. */
  sessionId: string
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type CapabilityId =
  | "read-only"
  | "write"
  | "verify"
  | "model-fanout"
  | "parallel"
  | "approvals"
  | "structured-deliverables"
  | "advisor-bridge"
  | "live-observation"
  | "native-live-attach"
  | "explicit-handoff"
  | "post-exit-resume"
  | "usage-reporting"

/**
 * A capability is a described capability, not a boolean brand flag (design D4):
 * the same feature name can be unavailable, restricted by auth/version, or
 * available with disclosed semantics.
 */
export type Capability =
  | { id: CapabilityId; availability: "available"; semantics?: string }
  | { id: CapabilityId; availability: "restricted"; reason: string; remediation?: string }
  | { id: CapabilityId; availability: "unavailable"; reason: string; remediation?: string }

export type RunnerCapabilities = {
  runner: RunnerId
  /** Version string of the resolved harness, when known. */
  version?: string
  capabilities: readonly Capability[]
}

export function capability(
  resolved: RunnerCapabilities,
  id: CapabilityId,
): Capability | undefined {
  return resolved.capabilities.find((entry) => entry.id === id)
}

export function isAvailable(resolved: RunnerCapabilities, id: CapabilityId): boolean {
  return capability(resolved, id)?.availability === "available"
}

// ---------------------------------------------------------------------------
// Authentication and billing (design D3)
// ---------------------------------------------------------------------------

export type AuthenticationMode = "subscription" | "api-key"

/**
 * Authentication and billing are independent. Subscription auth does not imply
 * free usage; `account-policy` acknowledges the account may charge usage credits
 * or paid features without changing credentials.
 */
export type BillingPolicy = "included-only" | "account-policy"

export type AuthenticationSelection = {
  mode: AuthenticationMode
  /** Required only for `subscription`; irrelevant for API-key/OpenCode. */
  billingPolicy?: BillingPolicy
  /**
   * Non-secret reference to an external credential (env var name or path). The
   * credential value itself MUST NOT be stored in a plan or metadata.
   */
  credentialRef?: string
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A runner-scoped model reference. Only the owning adapter interprets it. */
export type ModelReference = {
  runner: RunnerId
  /** Opaque model identifier (e.g. `provider/model` for OpenCode, alias for Claude). */
  modelId: string
  variant?: string
  effort?: string
}

// ---------------------------------------------------------------------------
// Agents and attachments
// ---------------------------------------------------------------------------

export type ExecutionMode = "read-only" | "verify" | "write"

export type LogicalAgent = {
  name: string
  /** System instructions (vendor-neutral text). */
  instructions?: string
  mode: ExecutionMode
  model: ModelReference
  /** Logical tool allow/deny intent; adapters map to native policy. */
  tools?: { allow?: readonly string[]; deny?: readonly string[] }
  options?: Record<string, unknown>
}

export type AttachmentDescriptor = {
  kind: "file" | "directory" | "content"
  /** Absolute path for `file`/`directory`; absent for inline `content`. */
  path?: string
  mime: string
  filename?: string
  /** Inline payload for `content` attachments. */
  data?: string
}

// ---------------------------------------------------------------------------
// Approval policy (design D7)
// ---------------------------------------------------------------------------

export type ApprovalMode = "interactive" | "auto" | "smart"

// ---------------------------------------------------------------------------
// Execution request / outcome
// ---------------------------------------------------------------------------

export type ExecutionRequest = {
  runId: string
  phaseName: string
  attempt: number
  runner: RunnerId
  /** Verified checkout the attempt may operate in. */
  checkout: string
  agent: LogicalAgent
  prompt: string
  auth: AuthenticationSelection
  mode: ExecutionMode
  approvals: ApprovalMode
  attachments?: readonly AttachmentDescriptor[]
  /** Opaque per-attempt deliverable contract id, validated by core. */
  deliverableContract?: string
  /** Continue this exact recorded session instead of creating a new one (D11). */
  continueSession?: RunnerSessionRef
  signal: AbortSignal
}

export type Usage = {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  /** Monetary estimate when the harness reports one; never an invoice. */
  costEstimate?: number
  /** True when the value includes earlier turns (requires baseline subtraction). */
  cumulative?: boolean
}

export type TerminalStatus = "completed" | "failed" | "interrupted" | "uncertain"

export type AttemptOutcome = {
  status: TerminalStatus
  session?: RunnerSessionRef
  /** Harness-reported finish reason, when exposed (e.g. `length`, `stop`). */
  finish?: string
  usage?: Usage
  /** Final assistant text when the harness reports it. */
  assistantText?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Observation events (design D6)
// ---------------------------------------------------------------------------

type EventBase = { runner: RunnerId; attempt: number }

export type RunnerEvent =
  | (EventBase & { type: "session"; session: RunnerSessionRef })
  | (EventBase & { type: "text"; text: string; partId?: string })
  | (EventBase & { type: "reasoning"; text: string; partId?: string })
  | (EventBase & { type: "tool"; name: string; detail?: string })
  | (EventBase & { type: "usage"; usage: Usage })
  | (EventBase & { type: "permission-request"; requestId: string; action: string; resources?: readonly string[] })
  | (EventBase & { type: "permission-settled"; requestId: string; decision: "allow" | "deny" | "expired" })
  | (EventBase & { type: "terminal"; outcome: AttemptOutcome })

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * The execution port. An adapter prepares its own runtime internally and never
 * leaks vendor clients into the core (design D1). Optional control/conversation
 * operations are separate interfaces so adapters need not implement what they
 * cannot honor.
 */
export interface ExecutionAdapter {
  readonly id: RunnerId
  /** Resolve effective capabilities for the current install/auth (design D4). */
  capabilities(auth?: AuthenticationSelection): Promise<RunnerCapabilities>
  /** Run one attempt, emitting normalized events and resolving to its outcome. */
  executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void): Promise<AttemptOutcome>
  /** Cancel the identified attempt if this adapter is currently running it. */
  cancelAttempt(attempt: { runId: string; attempt: number }): Promise<void>
}

/** Optional conversation/control surface; only implemented where honored. */
export interface ConversationAdapter {
  openSession(input: { checkout: string; session: RunnerSessionRef }): Promise<void>
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type RunnerRegistration = {
  id: RunnerId
  execution: ExecutionAdapter
  conversation?: ConversationAdapter
}

export class RunnerRegistry {
  private readonly adapters = new Map<RunnerId, RunnerRegistration>()

  register(registration: RunnerRegistration): void {
    if (this.adapters.has(registration.id)) {
      throw new Error(`runner already registered: ${registration.id}`)
    }
    if (registration.execution.id !== registration.id) {
      throw new Error(`execution adapter id ${registration.execution.id} does not match registration ${registration.id}`)
    }
    this.adapters.set(registration.id, registration)
  }

  has(id: RunnerId): boolean {
    return this.adapters.has(id)
  }

  get(id: RunnerId): RunnerRegistration | undefined {
    return this.adapters.get(id)
  }

  require(id: RunnerId): RunnerRegistration {
    const found = this.adapters.get(id)
    if (!found) throw new Error(`no adapter registered for runner: ${id}`)
    return found
  }

  list(): readonly RunnerId[] {
    return [...this.adapters.keys()]
  }
}
