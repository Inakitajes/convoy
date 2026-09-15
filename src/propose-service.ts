/**
 * Proposal-command ownership (change `fix-opencode-server-lifecycle`, design
 * D1/D6).
 *
 * The proposal fallback boots a temporary, run/helper-classified `opencode
 * serve` to discover the project's authoring commands. That helper must never
 * run the command: an authoring command can start independent execution, so it
 * runs under the repository's independently persistent conversation service
 * (published or reused under that service's discovery lock). The unused helper
 * is stopped on every path — unknown discovery, no usable command, a lost
 * writer claim, transfer failure, and transfer success — so recovery can never
 * mistake active authoring for an abandoned helper.
 *
 * Extracted from `cli.ts` so the ordering (transfer strictly before command
 * invocation) and the guaranteed helper stop are unit-testable without booting
 * a real server or TUI.
 */

export type AuthoringServiceHandle = { url: string }

export type AuthoringConversationRef = { harness: "opencode"; sessionId: string }

/** The server availability the caller resolved before invoking the workflow. */
export type ProposalServer =
  | { kind: "independent"; url: string }
  | { kind: "helper"; url: string }

export type ProposalCommandDeps = {
  /** The project's authoring commands on a server; `"unknown"` means unreadable. */
  listCommands: (server: AuthoringServiceHandle) => Promise<string[] | "unknown">
  /** Publishes or reuses the repository's independent authoring service. */
  transfer: () => Promise<{ status: "live"; url: string } | { status: "unavailable" | "uncertain"; reason: string }>
  /** Stops the owned temporary helper; idempotent and only called for a helper. */
  stopHelper: () => Promise<unknown>
  /** Takes the checkout's managed-writer claim; `ok: false` carries the guidance. */
  acquireClaim: () => Promise<{ ok: true } | { ok: false; reason: string; remediation: string[] }>
  /** Releases a claim this operation took on a failure path. */
  releaseClaim: () => Promise<unknown>
  createConversation: (server: AuthoringServiceHandle) => Promise<AuthoringConversationRef>
  invokeCommand: (input: { ref: AuthoringConversationRef; server: AuthoringServiceHandle; command: string }) => Promise<void>
}

export type ProposalCommandOutcome =
  | { status: "started"; ref: AuthoringConversationRef; service: AuthoringServiceHandle }
  | { status: "blocked"; reason: string; remediation: string[] }

const checkCommandsRemediation = ["check the project's .opencode/commands/ directory — Convoy does not install commands into it"]
const manualRemediation = ["open an ordinary conversation in the worktree instead"]
const discoverCommandRemediation = ["author the change manually in a conversation"]

/** The proposal workflow command the fallback looks for. */
export function findProposalCommand(commands: readonly string[]): string | undefined {
  return commands.find((name) => name === "opsx-propose") ?? commands.find((name) => name.endsWith("propose"))
}

/**
 * Runs the full proposal workflow under the correct process ownership:
 * discovery → writer claim → (helper) transfer to the independent service →
 * conversation creation → command invocation. A temporary helper is stopped on
 * every path that does not need it, including just before a command runs under
 * the transferred service.
 */
export async function startProposalCommand(server: ProposalServer, deps: ProposalCommandDeps): Promise<ProposalCommandOutcome> {
  const owned = server.kind === "helper"
  let helperStopped = false
  const stopOwnedHelper = async () => {
    if (!owned || helperStopped) return
    helperStopped = true
    await deps.stopHelper()
  }

  // A function-level finally guarantees the owned helper is stopped on every
  // path, including a `listCommands` or `acquireClaim` that throws before the
  // post-claim try below (design D1). `stopOwnedHelper` is idempotent, so the
  // explicit calls on the return paths remain the primary stop and this is the
  // safety net for a throw.
  try {
    const commands = await deps.listCommands({ url: server.url })
    if (commands === "unknown") {
      await stopOwnedHelper()
      return { status: "blocked", reason: "the project's authoring commands could not be discovered", remediation: checkCommandsRemediation }
    }
    const command = findProposalCommand(commands)
    if (!command) {
      await stopOwnedHelper()
      return {
        status: "blocked",
        reason: "this project has no supported proposal workflow command (looked for opsx-propose under .opencode/commands/)",
        remediation: discoverCommandRemediation,
      }
    }

    const claim = await deps.acquireClaim()
    if (!claim.ok) {
      await stopOwnedHelper()
      return { status: "blocked", reason: claim.reason, remediation: claim.remediation }
    }

    let service: AuthoringServiceHandle = { url: server.url }
    try {
      if (owned) {
        // The helper may only discover. Publish or reuse the independent service
        // before any command runs, then stop the helper whether the transfer
        // succeeded or not — it is never the command's owner.
        const transfer = await deps.transfer()
        await stopOwnedHelper()
        if (transfer.status !== "live") {
          await deps.releaseClaim()
          return {
            status: "blocked",
            reason: `the authoring service could not be established independently: ${transfer.reason}`,
            remediation: manualRemediation,
          }
        }
        service = { url: transfer.url }
      }
      const ref = await deps.createConversation(service)
      await deps.invokeCommand({ ref, server: service, command })
      return { status: "started", ref, service }
    } catch (error) {
      await stopOwnedHelper()
      await deps.releaseClaim()
      return {
        status: "blocked",
        reason: `the authoring workflow could not start: ${error instanceof Error ? error.message : String(error)}`,
        remediation: manualRemediation,
      }
    }
  } finally {
    await stopOwnedHelper()
  }
}
