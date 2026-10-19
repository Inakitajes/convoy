/**
 * Built-in capability declarations (change `unify-runner-system`, task 1.7).
 *
 * Each adapter's capabilities are declared once, here, in a vendor-free module
 * that both the adapter and preflight resolve from. There is no second
 * brand-based table: `opencodeCapabilities()` and the Claude adapter's
 * `capabilities()` are thin wrappers over these declarations, so the surface
 * advertised before a run and the one honored during it cannot disagree.
 */

import type { CapabilityDeclaration, CapabilityId } from "./contracts"

function supportedMajor(version?: string): number | undefined {
  if (!version) return undefined
  const major = Number(version.split(".")[0])
  return Number.isInteger(major) ? major : undefined
}

export const opencodeDeclaration: CapabilityDeclaration = {
  runner: "opencode",
  available: [
    "read-only",
    "write",
    "verify",
    "model-fanout",
    "parallel",
    "approvals",
    "structured-deliverables",
    "advisor-bridge",
    "live-observation",
    "session-history",
    "native-live-attach",
    "explicit-handoff",
    "post-exit-resume",
    "usage-reporting",
    "loop-guard",
  ],
  restrictions: [
    {
      ids: [
        "read-only",
        "write",
        "verify",
        "model-fanout",
        "parallel",
        "approvals",
        "structured-deliverables",
        "advisor-bridge",
        "live-observation",
        "session-history",
        "native-live-attach",
        "explicit-handoff",
        "post-exit-resume",
        "usage-reporting",
        "loop-guard",
      ] satisfies readonly CapabilityId[],
      when: (evidence) => {
        const major = supportedMajor(evidence.version)
        return major !== undefined && major !== 2
      },
      reason: (evidence) => `OpenCode ${evidence.version} is not a supported V2 runtime`,
    },
  ],
}

export const claudeDeclaration: CapabilityDeclaration = {
  runner: "claude-code",
  available: [
    "read-only",
    "write",
    "verify",
    "model-fanout",
    "parallel",
    "approvals",
    "structured-deliverables",
    "advisor-bridge",
    "live-observation",
    "post-exit-resume",
    "usage-reporting",
  ],
  semantics: {
    "live-observation": "streamed to the coordinator's journal; not a native attach",
    "usage-reporting": "subscription values are estimates",
    approvals:
      "Convoy's policy is enforced by a PreToolUse hook and an MCP permission host; an ask-level action reaches the run's operator gate (auto-accept, smart judge, prompt) through a per-attempt loopback bridge",
    "structured-deliverables":
      "reports, scores, and commit descriptions are submitted through Convoy's write_report MCP tool and validated like OpenCode's; the final assistant text remains the fallback report",
    "advisor-bridge":
      "Convoy's advisor MCP tools and a PreToolUse first-write checkpoint, consulting the step's advisor (Claude or OpenCode) over the transcript Convoy recorded",
  },
  unavailable: [
    { id: "native-live-attach", reason: "print mode has no attachable live session" },
    { id: "session-history", reason: "print mode does not expose a recorded transcript to reconstruct" },
    {
      id: "loop-guard",
      reason: "print mode cannot take a nudge mid-turn, so Convoy's repeated-call and cost guard does not apply to Claude steps",
      remediation: "bound the step with Claude's own limits or run it on OpenCode",
    },
  ],
  restricted: [
    {
      id: "explicit-handoff",
      reason: "requires a verified quiesced handoff",
      remediation: "use post-exit resume or observe",
    },
  ],
  restrictions: [
    {
      ids: ["approvals", "advisor-bridge"],
      when: (evidence) => evidence.enforcementReady === false,
      reason: "mandatory enforcement (hook + permission host) is not installed",
    },
  ],
}

/** The oldest Codex release whose app-server protocol the Codex adapter is tested against. */
export const minimumCodexVersion = "0.160.0"

/**
 * Why a Codex release cannot run Convoy's attempts, or undefined when it can.
 * A release Codex did not report readably is refused: an unknown protocol is
 * never taken as a supported one.
 */
export function codexVersionProblem(version: string | undefined): string | undefined {
  const parts = version?.split(/[.-]/).slice(0, 3).map(Number)
  if (!parts || parts.length < 3 || parts.some((part) => !Number.isInteger(part))) {
    return `Codex did not report a readable release${version ? ` ("${version}")` : ""}; Convoy needs ${minimumCodexVersion} or later`
  }
  const minimum = minimumCodexVersion.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i]! < minimum[i]! ? `Codex ${version} predates the supported app-server protocol (${minimumCodexVersion} or later)` : undefined
  }
  return undefined
}

const codexCapabilities = [
  "read-only",
  "write",
  "verify",
  "model-fanout",
  "parallel",
  "approvals",
  "structured-deliverables",
  "advisor-bridge",
  "live-observation",
  "post-exit-resume",
  "usage-reporting",
  "loop-guard",
] as const satisfies readonly CapabilityId[]

export const codexDeclaration: CapabilityDeclaration = {
  runner: "codex",
  available: codexCapabilities,
  semantics: {
    approvals:
      "every command, file change and MCP call arrives as an app-server approval request; Convoy's policy and the run's operator gate (auto-accept, smart judge, prompt) answer it one action at a time",
    "structured-deliverables":
      "reports, scores, and commit descriptions are submitted through Convoy's write_report MCP tool and validated like the other runners'; the final agent message remains the fallback report",
    "advisor-bridge":
      "Convoy's advisor MCP tools and a first-write checkpoint that declines the first file change and steers the advice into the running turn",
    "live-observation": "streamed to the coordinator's journal; not a native attach",
    "usage-reporting": "token usage per turn; subscription values are estimates",
    "loop-guard": "a nudge steers the running turn and a stop interrupts it",
  },
  unavailable: [
    { id: "native-live-attach", reason: "attaching a Codex client to a run's app-server is not verified" },
    { id: "session-history", reason: "Convoy's journal is the transcript; Codex thread history is not reconstructed" },
  ],
  restricted: [
    {
      id: "explicit-handoff",
      reason: "requires a verified quiesced handoff",
      remediation: "use post-exit resume or observe",
    },
  ],
  restrictions: [
    {
      ids: codexCapabilities,
      when: (evidence) => evidence.version !== undefined && codexVersionProblem(evidence.version) !== undefined,
      reason: (evidence) => codexVersionProblem(evidence.version!)!,
      remediation: "update Codex with `codex update`",
    },
    {
      ids: ["advisor-bridge"],
      when: (evidence) => evidence.enforcementReady === false,
      reason: "Convoy's MCP host is not available to serve the advisor tools",
    },
  ],
}
