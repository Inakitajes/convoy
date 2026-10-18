/**
 * Runner descriptors (change `generalize-runner-routes`, design D4).
 *
 * Each runner is described once, here: its identity and labels, its capability
 * declaration, the models it executes and how a model maps to its native form,
 * the binary that proves it is installed, and the name its agents see for
 * Convoy's report tool. Routing, config validation, plan dependencies,
 * preflight and prompts read these descriptors instead of comparing runner
 * names, so adding a runner means adding a descriptor and its adapter.
 *
 * Vendor-free: this module imports only contracts and declarations, so config
 * and pipeline resolution can read it without loading any harness.
 */

import type { CapabilityDeclaration } from "./contracts"
import { claudeDeclaration, codexDeclaration, opencodeDeclaration } from "./declarations"

/** Registered runner identifiers. Adding a runner adds its descriptor below. */
export const runnerIds = ["opencode", "claude-code", "codex"] as const
export type RegisteredRunnerId = (typeof runnerIds)[number]

/** How a runner reads model references. */
export type RunnerModelSupport = {
  /**
   * True when the runner's model references are qualified by the runner
   * (`<runner>/<model>`), because the runner executes one provider's models
   * through its own CLI. False when they are qualified by a provider
   * (`provider/model`), as OpenCode's catalog is.
   */
  qualified: boolean
  /** The provider whose models the runner executes; absent means any configured provider. */
  provider?: string
  /** Runner-local model aliases the CLI resolves itself (e.g. `opus`). */
  aliases?: readonly string[]
  /**
   * The `#variant` values the runner honors (mapped to its own effort or
   * variant setting). Absent means any provider variant; empty means none.
   */
  variants?: readonly string[]
  /** A one-line description of accepted models, quoted by validation errors. */
  hint: string
}

export type RunnerDescriptor = {
  id: RegisteredRunnerId
  displayName: string
  /** Short session label shown in dashboards and logs. */
  sessionName: string
  /** The CLI binary whose presence on PATH proves the runner is installed; absent when the runner resolves its own. */
  binary?: string
  declaration: CapabilityDeclaration
  models: RunnerModelSupport
  /** How the agent names Convoy's report tool in this runner. */
  reportTool: string
  /** The model (and variant) a helper or judge route on this runner uses when it names none; empty keeps the runner's default. */
  helperModel?: { model: string; variant?: string }
  /** The model an advisor route on this runner uses when it names none. */
  advisorModel?: { model: string; variant?: string }
  /**
   * True when Convoy selects this runner's billing source per route
   * (subscription login or an API-key reference) and verifies it before use.
   * False when the runner authenticates through its own provider config.
   */
  authenticates: boolean
  /** How to install the runner, quoted when a plan needs it and it is missing. */
  installHint?: string
  /**
   * Why linked authoring conversations (Iterate, Propose, worktree
   * conversations) are unavailable on this runner; absent when they are.
   */
  conversationsUnavailable?: string
}

const descriptors: Record<RegisteredRunnerId, RunnerDescriptor> = {
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    sessionName: "opencode",
    declaration: opencodeDeclaration,
    models: { qualified: false, hint: "provider/model[#variant]" },
    reportTool: "`write_report`",
    authenticates: false,
  },
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    sessionName: "claude",
    binary: "claude",
    declaration: claudeDeclaration,
    models: {
      qualified: true,
      provider: "anthropic",
      aliases: ["opus", "sonnet", "haiku"],
      variants: [],
      hint: "Anthropic models: use a CLI alias (opus, sonnet, haiku), a claude-* ID, or anthropic/<id>",
    },
    reportTool: "`write_report` (`mcp__convoy__write_report`)",
    helperModel: { model: "haiku" },
    advisorModel: { model: "sonnet" },
    authenticates: true,
    installHint: "install Claude Code (https://code.claude.com)",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    sessionName: "codex",
    binary: "codex",
    declaration: codexDeclaration,
    models: {
      qualified: true,
      provider: "openai",
      variants: ["minimal", "low", "medium", "high", "xhigh"],
      hint: "OpenAI models: use openai/<id> or a bare Codex model ID, with an optional #effort (minimal, low, medium, high, xhigh)",
    },
    reportTool: "`write_report` (from the `convoy` MCP server)",
    helperModel: { model: "", variant: "low" },
    advisorModel: { model: "" },
    authenticates: true,
    installHint: "install Codex (`npm install -g @openai/codex`) and sign in with `codex login`",
    conversationsUnavailable: "Codex assigns a conversation's thread id itself, so Convoy cannot link an authoring conversation to the worktree",
  },
}

export function runnerDescriptor(id: RegisteredRunnerId): RunnerDescriptor {
  return descriptors[id]
}

export function isRegisteredRunnerId(value: unknown): value is RegisteredRunnerId {
  return typeof value === "string" && (runnerIds as readonly string[]).includes(value)
}

/** Every registered runner ID, quoted and joined for an error message. */
export function runnerIdChoices(): string {
  return runnerIds.map((id) => `"${id}"`).join(", ").replace(/, ("[^"]+")$/, ", or $1")
}

/**
 * The runner a qualified model reference names by its first segment
 * (`claude-code/opus`, `codex/gpt-5.5`). A provider-qualified reference
 * (`openai/gpt-5.5`) names no runner, and neither does a runner whose models
 * are provider-qualified, since its ID can also be a provider (`opencode/<id>`
 * is an OpenCode Zen model).
 */
export function qualifiedRunnerOf(reference: string): RegisteredRunnerId | undefined {
  const head = reference.split("/", 1)[0]
  if (!isRegisteredRunnerId(head)) return undefined
  return descriptors[head].models.qualified ? head : undefined
}

/**
 * The native model a qualified runner executes for a reference, with its
 * variant split off. Accepts the canonical `provider/model` form, a bare model
 * ID, and the runner's aliases; refuses another provider's model rather than
 * guessing an equivalent.
 */
export function normalizeQualifiedModel(id: RegisteredRunnerId, raw: string): { model: string; variant?: string } {
  const support = descriptors[id].models
  const value = raw.trim()
  const hash = value.indexOf("#")
  const reference = hash === -1 ? value : value.slice(0, hash)
  const variant = hash === -1 ? undefined : value.slice(hash + 1)
  const fail = (detail?: string): never => {
    throw new Error(`runner ${id} executes ${support.hint}${detail ? `; ${detail}` : ""}`)
  }
  if (variant !== undefined) {
    if (support.variants?.length === 0) fail(`${descriptors[id].displayName} models do not take a #variant`)
    if (support.variants && !support.variants.includes(variant)) fail(`"#${variant}" is not one of ${support.variants.join(", ")}`)
  }
  const slash = reference.indexOf("/")
  let model = reference
  if (slash !== -1) {
    const provider = reference.slice(0, slash)
    if (support.provider === undefined || provider !== support.provider) fail(`got "${value}"`)
    model = reference.slice(slash + 1)
  }
  if (model.length > 0 && !/^[^\s/#]+$/.test(model)) fail(`got "${value}"`)
  if (support.provider === "anthropic" && model.length > 0 && !support.aliases?.includes(model) && !/^claude-[^/#]+$/.test(model)) fail()
  return { model, ...(variant ? { variant } : {}) }
}
