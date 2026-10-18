/**
 * Codex child authentication (change `add-codex-runner`, design D5).
 *
 * Subscription mode runs on the operator's Codex ChatGPT login: ambient
 * OpenAI keys are removed from the child so they cannot silently become the
 * billing source. API-key mode never touches the operator's
 * `~/.codex/auth.json`: the key is logged in to an owner-only, per-use
 * `CODEX_HOME` under Convoy's private directory, which is discarded after use.
 *
 * Either way the overlay is only an intent. `verifyCodexAccount` reads the
 * account Codex actually resolved (`account/read`) and refuses a mismatch, so
 * an attempt never bills a source the operator did not review.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

import { withoutHerdrEnv } from "../../herdr"
import { convoySecretsDir } from "../../workspace"
import type { AuthenticationSelection } from "../contracts"
import { redactSecrets, registerSecret } from "../redaction"
import { asRecord, stringField } from "./protocol"

/** Ambient variables that would let an inherited OpenAI credential change Codex's billing source. */
export const codexCredentialEnvVars = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexAuthError"
  }
}

/** The prepared child environment for one Codex process, and how to discard what it staged. */
export type CodexAuthEnvironment = {
  mode: AuthenticationSelection["mode"]
  env: NodeJS.ProcessEnv
  /** Non-secret description for review and logs. */
  description: string
  discard(): Promise<void>
}

export type CodexLogin = (input: { binary: string; env: NodeJS.ProcessEnv; key: string; cwd: string }) => Promise<{ code: number; stderr: string }>

/** `codex login --with-api-key`, reading the key from stdin so it never reaches argv. */
export const defaultCodexLogin: CodexLogin = async ({ binary, env, key, cwd }) => {
  const proc = Bun.spawn([binary, "login", "--with-api-key"], { cwd, env, stdin: new Blob([`${key}\n`]), stdout: "ignore", stderr: "pipe" })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, stderr }
}

const credentialRefPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Prepares the child environment for a reviewed selection. Throws
 * `CodexAuthError` for a selection that cannot be satisfied rather than
 * falling back to another billing source.
 */
export async function prepareCodexAuth(input: {
  selection: AuthenticationSelection
  env?: NodeJS.ProcessEnv
  binary?: string
  cwd: string
  login?: CodexLogin
}): Promise<CodexAuthEnvironment> {
  const { selection } = input
  const base = withoutHerdrEnv(input.env ?? process.env)
  for (const key of codexCredentialEnvVars) delete base[key]

  if (selection.billingPolicy !== undefined && selection.billingPolicy !== "included-only" && selection.billingPolicy !== "account-policy") {
    throw new CodexAuthError(`Unsupported billingPolicy "${String(selection.billingPolicy)}"; expected "included-only" or "account-policy".`)
  }

  if (selection.mode === "subscription") {
    if (selection.credentialRef) {
      throw new CodexAuthError(
        `Codex subscription mode must not carry a credential reference (got "${selection.credentialRef}"). Remove credentialRef to use the operator's Codex login, or select api-key mode explicitly.`,
      )
    }
    return {
      mode: "subscription",
      env: base,
      description: "Codex subscription: uses the operator's Codex ChatGPT login; ambient OpenAI API keys are removed for this child.",
      discard: async () => {},
    }
  }

  if (selection.mode === "api-key") {
    const ref = selection.credentialRef
    if (!ref || !credentialRefPattern.test(ref)) {
      throw new CodexAuthError("Codex api-key mode requires credentialRef naming the environment variable that holds the key.")
    }
    const key = (input.env ?? process.env)[ref]
    if (!key) {
      throw new CodexAuthError(`Codex api-key mode: environment variable "${ref}" is missing or empty. Set it in the launch environment or choose a different credentialRef.`)
    }
    registerSecret(key)
    const root = join(convoySecretsDir(), "codex-home")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const home = await mkdtemp(join(root, "home-"))
    const discard = () => rm(home, { recursive: true, force: true }).catch(() => {})
    const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: home }
    try {
      const result = await (input.login ?? defaultCodexLogin)({ binary: input.binary ?? "codex", env, key, cwd: input.cwd })
      if (result.code !== 0) throw new CodexAuthError(`codex login --with-api-key failed (status ${result.code})${result.stderr.trim() ? `: ${redactSecrets(result.stderr.trim().split("\n").slice(-2).join(" "))}` : ""}`)
    } catch (error) {
      await discard()
      throw error instanceof CodexAuthError ? error : new CodexAuthError(error instanceof Error ? error.message : String(error))
    }
    return {
      mode: "api-key",
      env,
      description: `Codex API key from environment variable "${ref}", logged in to a private Codex home for this child only; the operator's Codex login is untouched.`,
      discard,
    }
  }

  throw new CodexAuthError(`Unsupported Codex authentication mode "${String(selection.mode)}"; expected "subscription" or "api-key".`)
}

/**
 * Compares the account Codex resolved (`account/read`) with the reviewed
 * mode. Returns an error message for a mismatch, undefined when it matches.
 */
export function codexAccountMismatch(mode: AuthenticationSelection["mode"], accountResult: unknown): string | undefined {
  const account = asRecord(asRecord(accountResult)?.account)
  const type = stringField(account, "type")
  if (!type) return `Codex reports no login; run \`codex login\`${mode === "api-key" ? " or check the API key" : ""} before starting the run.`
  if (mode === "subscription" && type !== "chatgpt") {
    return `Codex would bill ${type === "apiKey" ? "an API key" : `a ${type} account`}, but this route was reviewed as a subscription (ChatGPT login).`
  }
  if (mode === "api-key" && type !== "apiKey") {
    return `Codex would bill a ${type} account, but this route was reviewed as an API key.`
  }
  return undefined
}
