/**
 * The reviewed action policy for one phase attempt.
 *
 * Core decides the policy, adapters enforce it (see `policy.ts`). This builds
 * the same rules the OpenCode run config encodes — the bash allow/deny/ask
 * ruleset, reads and writes confined to the checkout and the run directory
 * (plus the attachments for reads), the run's private directory off limits — so a harness that enforces through an
 * out-of-process hook (Claude) applies exactly what OpenCode applies natively.
 */

import { realpathSync } from "node:fs"

import type { ApprovalMode, ExecutionMode } from "./contracts"
import type { CommandEffect, PolicyConfig } from "./policy"

/** The run's live auto-accept mode, as the dashboard toggles it. */
export type AutoAcceptMode = "off" | "all" | "smart"

export type PhasePolicyInput = {
  mode: ExecutionMode
  autoAccept: AutoAcceptMode
  /** The step's checkout. */
  checkout: string
  /** The run directory (reports, attachments). */
  runDir: string
  /** Private directories no action may touch (the run's server password and bridge tokens, Convoy's secrets). */
  privateDirs: readonly string[]
  /** The assembled bash ruleset (`bashPolicy`), in evaluation order. */
  commands: Readonly<Record<string, CommandEffect>>
  /** Absolute paths of the attempt's attachments (files or directories), readable wherever they live. */
  attachments?: readonly string[]
  /** The phase consults an advisor: its first write waits for the first-write checkpoint. */
  advised?: boolean
}

/** Maps the auto-accept mode onto the approval mode an `ask` follows. */
export function approvalsFor(autoAccept: AutoAcceptMode): ApprovalMode {
  if (autoAccept === "all") return "auto"
  if (autoAccept === "smart") return "smart"
  return "interactive"
}

/**
 * A root as given and as the filesystem resolves it. A harness reports the
 * paths it touches in either form (macOS `/var` is `/private/var`), so a root
 * must match both or a legitimate write is refused — and a protected path
 * reached through its real form slips through.
 */
export function rootForms(path: string): string[] {
  try {
    const real = realpathSync(path)
    return real === path ? [path] : [path, real]
  } catch {
    return [path]
  }
}

export function phasePolicy(input: PhasePolicyInput): PolicyConfig {
  return {
    mode: input.mode,
    approvals: approvalsFor(input.autoAccept),
    commands: input.commands,
    writeRoots: [...rootForms(input.checkout), ...rootForms(input.runDir)],
    denyRoots: input.privateDirs.flatMap(rootForms),
    // Reads elsewhere are denied, as OpenCode's external_directory rule does.
    readRoots: (input.attachments ?? []).flatMap(rootForms),
    cwd: input.checkout,
    ...(input.advised ? { requireAdvisorBeforeWrite: true } : {}),
  }
}
