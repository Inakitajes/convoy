import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { addWorktree } from "./git"
import { log } from "./log"
import { startOpencode } from "./opencode"
import { splitModelVariant } from "./pipeline"
import { parseModel } from "./runner"
import { convoyHome } from "./workspace"

export type WorktreeResult = {
  /** Absolute path of the newly created worktree. */
  dir: string
  /** Name of the branch the worktree was created on. */
  branch: string
}

export type WorktreeInput = {
  targetDir: string
  prompt: string
  /** Commit/ref to base the new branch on; defaults to HEAD. */
  baseRef?: string
  /** Override the model used to name the branch (provider/model[#variant]). */
  model?: string
  signal?: AbortSignal
}

/** Cheap, fast model used to synthesize a branch name from the prompt. */
export const defaultBranchNameModel = "anthropic/claude-haiku-4-5"

// Generous enough for the namer to look up a referenced issue before answering;
// the deterministic fallback still guards the whole thing.
const branchNameTimeoutMs = 60_000
const maxBranchNameLength = 40

/**
 * Read-only permission set for the naming session, mirroring the read-only
 * agent shape in agents.ts. MCP tools from the user's opencode setup are left
 * untouched so issue trackers (Linear, GitHub) stay reachable.
 */
function namerOpencodeConfig(): Config {
  return {
    permission: {
      read: "allow",
      list: "allow",
      glob: "allow",
      grep: "allow",
      webfetch: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      question: "deny",
      websearch: "deny",
    },
  }
}

/**
 * Creates a new git branch checked out in a dedicated worktree under
 * `~/.convoy/worktrees/<slug>`, so Convoy runs against an isolated checkout
 * instead of the user's current working tree. The branch name is synthesized
 * from the prompt by a cheap model (Haiku by default), falling back to a
 * timestamped slug when the model is unavailable.
 */
export async function createIsolatedWorktree(input: WorktreeInput): Promise<WorktreeResult> {
  const base = input.baseRef ?? "HEAD"
  const branch = await generateBranchName(input.prompt, input.targetDir, input.model, input.signal)
  const slug = slugifyBranch(branch)
  const dir = join(convoyHome(), "worktrees", slug)
  await mkdir(join(convoyHome(), "worktrees"), { recursive: true })
  await addWorktree(dir, branch, base, input.targetDir)
  log.info(`created worktree at ${dir} on branch ${branch}`)
  return { dir, branch }
}

/**
 * Asks a cheap, read-only model for a short kebab-case branch name derived
 * from the prompt — it may look up referenced issues/tickets first. Any
 * failure (no auth, timeout, unparseable reply) falls back to a deterministic
 * slug so the worktree is always created.
 */
export async function generateBranchName(
  prompt: string,
  targetDir: string,
  model = defaultBranchNameModel,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = prompt.trim()
  if (!trimmed) return fallbackBranchName()
  try {
    const handle = await startOpencode(namerOpencodeConfig(), AbortSignal.timeout(branchNameTimeoutMs))
    try {
      const name = await askForBranchName(handle.client, trimmed, targetDir, model, signal)
      const cleaned = cleanBranchName(name)
      return cleaned || fallbackBranchName()
    } finally {
      handle.close()
    }
  } catch (error) {
    log.warn(`worktree: couldn't generate an AI branch name (${error instanceof Error ? error.message : String(error)}); using fallback`)
    return fallbackBranchName()
  }
}

export async function askForBranchName(
  client: OpencodeClient,
  prompt: string,
  targetDir: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const parsedModel = splitModelVariant(model)
  const session = await client.session.create(
    { directory: targetDir, title: "convoy branch namer" },
    { signal: signal ?? undefined },
  )
  if (session.error || !session.data?.id) throw new Error("couldn't open a naming session")
  const sessionID = session.data.id
  try {
    const response = await client.session.prompt(
      {
        sessionID,
        directory: targetDir,
        model: parseModel(parsedModel.model),
        ...(parsedModel.variant ? { variant: parsedModel.variant } : {}),
        system: branchNameSystemPrompt,
        tools: { read: true, list: true, glob: true, grep: true, webfetch: true, write: false, edit: false, bash: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: `Prompt:\n${truncate(prompt, 1200)}` }],
      },
      { signal: signal ?? undefined },
    )
    if (response.error || !response.data) throw new Error("branch namer returned no answer")
    return collectText(response.data.parts)
  } finally {
    try {
      await client.session.delete({ sessionID, directory: targetDir })
    } catch {
      // best-effort
    }
  }
}

const branchNameSystemPrompt = [
  "You name git branches. Read the user's prompt and reply with ONE short, lowercase, kebab-case",
  "branch name that captures what the work does. 2-5 words. No leading 'feature/', no quotes,",
  "no punctuation except hyphens, no explanation, no markdown. Examples:",
  "add-onboarding-flow, fix-login-redirect, refactor-config-tui, dark-mode-toggle.",
  "If the prompt references an issue, ticket, or PR (#123, ABC-123, a URL) instead of describing",
  "the work, first look it up with the tools available to you (issue-tracker tools, webfetch,",
  "repo files) and name the branch after what the issue is actually about. If the reference",
  "can't be resolved, use the issue ID itself as the name (e.g. dev-1339) — never transcribe",
  "the sentence around it. The last line of your reply must be the branch name alone.",
].join("\n")

/**
 * Keeps the model's reply within git's branch-name rules: lowercase,
 * kebab-case, <=40 chars. Reads the last non-empty line — a namer that
 * investigated an issue first may narrate before answering.
 */
export function cleanBranchName(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines[lines.length - 1] ?? ""
  const kebab = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxBranchNameLength)
  if (!kebab) return ""
  // Avoid a leading digit which can confuse some git/tooling; prefix "task-".
  return /^[0-9]/.test(kebab) ? `task-${kebab}` : kebab
}

/** Deterministic fallback so worktree creation never depends on a model being available. */
export function fallbackBranchName(): string {
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `convoy-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${randomSlug(4)}`
}

/** Filesystem-safe directory name for the worktree (mirrors the branch slug). */
export function slugifyBranch(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || `convoy-${randomSlug(6)}`
}

function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function randomSlug(size: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  for (const byte of bytes) out += chars[byte % chars.length]
  return out
}
