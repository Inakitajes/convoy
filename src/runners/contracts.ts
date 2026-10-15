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

/**
 * Collision-free attempt identity (change `unify-runner-system`, design D2).
 *
 * A phase's local attempt ordinal is not unique on its own: two phases running
 * in parallel in one run can both be on attempt 1. Run + phase + attempt names
 * exactly one attempt, so cancellation, pending decisions and service closures
 * are scoped to the attempt rather than to a bare number.
 */
export type AttemptIdentity = {
  /** Originating run. */
  runId: string
  /** Phase the attempt belongs to. */
  phaseName: string
  /** Local attempt ordinal within the phase; never unique on its own. */
  attempt: number
}

/**
 * Stable key for one attempt across a run. Mirrors the journal's record key so
 * two parallel phases with the same local ordinal never collide.
 */
export function attemptKey(identity: AttemptIdentity): string {
  return `${identity.runId}:${identity.phaseName}:${identity.attempt}`
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
  | "loop-guard"

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
  /** The exact attempt this request executes, collision-free across a run. */
  identity: AttemptIdentity
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
// Optional per-attempt services (design D1–D3)
//
// A runner implements the subset it can honour; core passes only what the
// runner advertises. Each contract carries the semantics the feature needs —
// a submission can be rejected, a protected write can be blocked, a loop
// observation can stop the attempt — not just a callback name.
// ---------------------------------------------------------------------------

/** The optional services a runner may advertise and receive. */
export type ServiceId = "approvals" | "deliverables" | "advisor" | "loop-guard"

/** The artifacts a supported runner may submit for validation. */
export type DeliverableKind = "report" | "score" | "commit-description"

export type DeliverableSubmission = {
  kind: DeliverableKind
  /** Markdown report, JSON score, or free-form commit description body. */
  body: string
  /**
   * Structured commit description for `commit-description`; preferred over the
   * free-form body when present.
   */
  commit?: { subject: string; details?: readonly string[] }
}

export type DeliverableResult =
  | { ok: true }
  | {
      ok: false
      error: string
      /** True when the same attempt may correct the submission and retry. */
      retryable: boolean
      /** True when the last accepted artifact was preserved, not replaced. */
      preserved: boolean
    }

export type DeliverableService = {
  /** Artifacts this attempt's contract expects (may be empty). */
  readonly expected: readonly DeliverableKind[]
  /** Validates and records one artifact; a rejection never replaces the last accepted one. */
  submit(submission: DeliverableSubmission): Promise<DeliverableResult>
}

// --- Approvals ------------------------------------------------------------

/** A normalized ask-level request. Hard policy denies are decided in core first. */
export type ApprovalRequest = {
  /** Stable id echoed on settlement/cancellation; a stale reply is refused. */
  requestId: string
  /** Native tool or action name, normalized for policy. */
  tool: string
  /** Normalized action kind used by policy (e.g. `read`, `write`, `bash`). */
  action: string
  /** Resources the action touches, when known. */
  resources?: readonly string[]
}

export type ApprovalOutcome = "allow" | "deny" | "expired"

export type ApprovalService = {
  /** Decide exactly the request it is given, never a sibling's. */
  decide(request: ApprovalRequest): Promise<ApprovalOutcome>
  /** Cancel a pending request when its attempt stops; idempotent. */
  cancel?(requestId: string): void
  /** True while this attempt still holds the request, so a late reply is refused. */
  isPending?(requestId: string): boolean
}

// --- Advisor --------------------------------------------------------------

/** Why the advisor is being consulted. */
export type AdvisorTrigger = "on-demand" | "first-write" | "completion"

export type AdvisorConsultation = {
  trigger: AdvisorTrigger
  question: string
  /** Bounded, normalized context supplied by core. */
  context?: string
}

export type AdvisorAdvice = {
  /** Advisor text: feedback, or correction guidance for a completion turn. */
  text: string
  /** True when this consultation satisfies the attempt's required checkpoint. */
  satisfiesCheckpoint: boolean
  /** Advisor usage, attributed separately from the executor's own usage. */
  usage?: Usage
}

export type AdvisorService = {
  /** When true, protected writes must wait for a satisfying consultation. */
  readonly requireBeforeWrite: boolean
  /** Whether the attempt's required checkpoint is satisfied right now. */
  satisfied(): boolean
  /** Runs one consultation; a failure throws and leaves the checkpoint unchanged. */
  consult(consultation: AdvisorConsultation): Promise<AdvisorAdvice>
}

// --- Loop guard / budget --------------------------------------------------

/**
 * One loop observation. `call`/`result` carry the stable call id and effective
 * arguments so repeated calls and repeated failures are detected even when a
 * tool name alone would collide; `usage` carries the message id so cumulative
 * figures are folded without double counting.
 */
export type LoopObservation =
  | { kind: "call"; tool: string; args?: unknown; callId?: string }
  | { kind: "result"; tool?: string; callId?: string; failed: boolean }
  | { kind: "step" }
  | { kind: "usage"; usage: Usage; messageId?: string }

export type LoopStopCode = "identical-calls" | "same-tool-failures" | "max-steps" | "max-cost"

/** The guard's decision for this attempt. An adapter must apply a `stop`. */
export type LoopDecision =
  | { action: "continue" }
  | { action: "nudge"; reason: string }
  | { action: "stop"; code: LoopStopCode; reason: string }

export type LoopGuardService = {
  /** Feeds one observation and returns the resulting decision for this attempt. */
  observe(observation: LoopObservation): LoopDecision
}

/** Optional services an attempt may be given (design D1/D2). */
export type ExecutionServices = {
  approvals?: ApprovalService
  deliverables?: DeliverableService
  advisor?: AdvisorService
  loopGuard?: LoopGuardService
}

/**
 * The execution port. An adapter prepares its own runtime internally and never
 * leaks vendor clients into the core (design D1). Optional services are passed
 * only when the runner advertises support for them.
 */
export interface ExecutionAdapter {
  readonly id: RunnerId
  /** Resolve effective capabilities for the current install/auth (design D4). */
  capabilities(auth?: AuthenticationSelection): Promise<RunnerCapabilities>
  /** Run one attempt, emitting normalized events and resolving to its outcome. */
  executeAttempt(
    request: ExecutionRequest,
    sink: (event: RunnerEvent) => void,
    services?: ExecutionServices,
  ): Promise<AttemptOutcome>
  /** Cancel the identified attempt if this adapter is currently running it. */
  cancelAttempt(attempt: AttemptIdentity): Promise<void>
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
