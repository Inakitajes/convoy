/**
 * One-shot helper inference by runner (change `generalize-runner-routes`).
 *
 * The smart judge, the branch namer, the commit writer and a CLI-routed
 * advisor need one bounded, tool-less (or read-only) answer. A runner that
 * runs its own CLI per call (Claude, Codex) registers its inference here; a
 * runner without one (OpenCode) answers on its server instead, so callers ask
 * this registry rather than comparing runner names.
 */

import type { StepRunnerId } from "../step-runners"
import { claudeInference, type ClaudeInferenceDeps } from "./claude/inference"
import { codexInference, type CodexInferenceDeps } from "./codex/inference"
import type { AuthenticationSelection, Usage } from "./contracts"

export type HelperInferenceInput = {
  prompt: string
  system: string
  /** The runner's native model; empty or `default` keeps the runner's own default. */
  model?: string
  /** A variant the runner maps to its own effort setting. */
  variant?: string
  auth: AuthenticationSelection
  cwd: string
  tools: "none" | "read-only"
  timeoutMs?: number
  signal?: AbortSignal
}

export type HelperInferenceResult = { text: string; usage?: Usage; sessionId?: string }

export type HelperInference = (input: HelperInferenceInput) => Promise<HelperInferenceResult>

/** Test seams for the CLI runners' inference. */
export type HelperInferenceSeams = {
  claude?: Partial<ClaudeInferenceDeps>
  codex?: CodexInferenceDeps
}

const registry: Partial<Record<StepRunnerId, (seams: HelperInferenceSeams) => HelperInference>> = {
  "claude-code": (seams) => (input) =>
    claudeInference(
      {
        prompt: input.prompt,
        system: input.system,
        ...(input.model ? { model: input.model } : {}),
        auth: input.auth,
        cwd: input.cwd,
        tools: input.tools,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      seams.claude,
    ),
  codex: (seams) => (input) => codexInference(input, seams.codex),
}

/** The runner's standalone helper inference, or undefined when it answers on a server (OpenCode). */
export function helperInferenceFor(runner: StepRunnerId, seams: HelperInferenceSeams = {}): HelperInference | undefined {
  return registry[runner]?.(seams)
}
