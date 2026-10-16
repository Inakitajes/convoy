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
    "live-observation",
    "post-exit-resume",
    "usage-reporting",
  ],
  semantics: {
    "live-observation": "streamed to the coordinator; not a native attach",
    "usage-reporting": "subscription values are estimates",
    approvals:
      "Convoy's policy is enforced by a PreToolUse hook and an MCP permission host; an ask-level action reaches the run's operator gate (auto-accept, smart judge, prompt) through a per-attempt loopback bridge",
    "structured-deliverables": "the report is the final assistant text or the report file, validated by Convoy after the attempt exits",
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
    {
      id: "advisor-bridge",
      reason: "the Claude adapter has no advisor bridge yet",
      remediation: "use an OpenCode advisor or omit the advisor for this step",
    },
  ],
  restrictions: [
    {
      ids: ["approvals"],
      when: (evidence) => evidence.enforcementReady === false,
      reason: "mandatory enforcement (hook + permission host) is not installed",
    },
  ],
}
