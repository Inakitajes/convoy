import { homedir } from "node:os"
import { join } from "node:path"

import { withoutHerdrEnv } from "./herdr"
import { openSessionCommand, shellQuote, type SessionWindowBackend } from "./opencode"
import { codexBinaryName } from "./runners/codex/adapter"
import { codexCredentialEnvVars, prepareCodexAuth } from "./runners/codex/auth"
import type { AuthenticationSelection } from "./runners/contracts"
import { convoySecretsDir } from "./workspace"

/**
 * Codex helpers shared by the runner and the CLI: reopening a finished
 * session (`codex resume`, `[o]`) and an interactive Codex window for a human
 * iteration or an authoring conversation, under the reviewed authentication.
 * Attempts themselves run through the adapter (runners/codex/adapter.ts),
 * never through this module.
 */

export { codexBinaryName }

const credentialRefPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The shell line that runs an interactive Codex command under the reviewed
 * billing source, as the headless adapter's overlay does: subscription drops
 * ambient OpenAI keys so the operator's ChatGPT login is used, and api-key
 * logs the key (read from its named variable at launch) in to a private,
 * owner-only Codex home that is removed when the client exits, so the
 * operator's own login is never touched. Only variable names are typed,
 * never a credential value.
 */
export function codexAuthShellCommand(command: string, auth: AuthenticationSelection = { mode: "subscription" }): string {
  const unset = `unset ${codexCredentialEnvVars.join(" ")};`
  if (auth.mode === "api-key") {
    const ref = auth.credentialRef
    if (!ref || !credentialRefPattern.test(ref)) throw new Error("Codex api-key mode needs credentialRef naming the variable that holds the key")
    const root = shellQuote(`${convoySecretsDir()}/codex-home`)
    return [
      `CONVOY_CODEX_KEY="$${ref}"; ${unset}`,
      `mkdir -p ${root} && chmod 700 ${root} && export CODEX_HOME="$(mktemp -d ${root}/interactive-XXXXXX)" &&`,
      `printf '%s\\n' "$CONVOY_CODEX_KEY" | ${codexBinaryName} login --with-api-key >/dev/null; unset CONVOY_CODEX_KEY;`,
      `${command}; rm -rf "$CODEX_HOME"`,
    ].join(" ")
  }
  return `${unset} ${command}`
}

/**
 * Why `codex resume` cannot bring a thread back, if it cannot. Codex keeps a
 * thread as a rollout file in the Codex home it ran under. An API-key thread
 * ran in a private per-use home that Convoy discards, so it is gone; any
 * other thread must be in the operator's Codex home.
 */
export async function codexResumeProblem(sessionID: string, auth: AuthenticationSelection = { mode: "subscription" }, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const discarded = `Codex thread ${sessionID} ran under API-key mode, in a private Codex home Convoy discards after use, so it cannot be reopened`
  if (auth.mode === "api-key") return discarded
  const home = env.CODEX_HOME || join(homedir(), ".codex")
  if (/^[A-Za-z0-9-]+$/.test(sessionID)) {
    try {
      for await (const _ of new Bun.Glob(`sessions/**/rollout-*-${sessionID}.jsonl`).scan({ cwd: home, onlyFiles: true })) return undefined
    } catch {
      // No Codex home: the thread is not there either.
    }
  }
  return `Codex thread ${sessionID} is not in your Codex home (${home}); a thread run under API-key mode lived in a private Codex home Convoy discards after use, so it cannot be reopened`
}

/**
 * Reopens a finished Codex session for the operator (`[o]`): Codex keeps the
 * thread on disk, so `codex resume` brings it back with its full context, in a
 * read-only sandbox that asks before anything runs. A thread Codex no longer
 * has is refused with its reason instead of opening an empty client.
 */
export async function openCodexSessionWindow(input: { targetDir: string; sessionID: string; auth?: AuthenticationSelection; env?: NodeJS.ProcessEnv }): Promise<SessionWindowBackend> {
  const problem = await codexResumeProblem(input.sessionID, input.auth, input.env)
  if (problem) throw new Error(problem)
  const command = [codexBinaryName, "resume", input.sessionID, "--sandbox", "read-only", "--ask-for-approval", "on-request"].map(shellQuote).join(" ")
  return openSessionCommand(codexAuthShellCommand(command, input.auth), input.targetDir, "codex session")
}

/**
 * Opens an interactive Codex session in the checkout for a human iteration or
 * authoring conversation: the operator's own Codex client, with its own
 * approvals and configuration, under the reviewed authentication. `resume`
 * reopens that exact thread; without it a fresh conversation starts.
 */
export async function openCodexInteractiveWindow(input: { targetDir: string; auth?: AuthenticationSelection; resume?: string; label?: string; prompt?: string }): Promise<SessionWindowBackend> {
  const problem = input.resume ? await codexResumeProblem(input.resume, input.auth) : undefined
  if (problem) throw new Error(problem)
  const args = [codexBinaryName, ...(input.resume ? ["resume", input.resume] : []), ...(input.prompt ? [input.prompt] : [])].map(shellQuote).join(" ")
  return openSessionCommand(codexAuthShellCommand(args, input.auth), input.targetDir, input.label ?? "codex session")
}

/** Runs an interactive Codex client in this terminal until it exits, under the reviewed authentication. */
export async function runInteractiveCodex(input: { targetDir: string; auth?: AuthenticationSelection; resume?: string }): Promise<number> {
  const problem = input.resume ? await codexResumeProblem(input.resume, input.auth) : undefined
  if (problem) throw new Error(problem)
  const auth = await prepareCodexAuth({ selection: input.auth ?? { mode: "subscription" }, env: process.env, cwd: input.targetDir })
  try {
    const proc = Bun.spawn([codexBinaryName, ...(input.resume ? ["resume", input.resume] : [])], {
      cwd: input.targetDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: withoutHerdrEnv(auth.env),
    })
    return await proc.exited
  } finally {
    await auth.discard()
  }
}
