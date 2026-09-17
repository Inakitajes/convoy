import type { Stats } from "node:fs"
import { access, constants, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { AgentConfig, Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { loadMergedConvoyConfig, type ConvoyConfig } from "./config"
import { addWorktree, branchExists } from "./git"
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
  /** The confirmed branch name; naming happens before the run is confirmed, never here. */
  branch: string
  /** Commit/ref to base the new branch on; defaults to HEAD. */
  baseRef?: string
}

export type BranchNameInput = {
  prompt: string
  targetDir: string
  /** Override the model used to name the branch (provider/model[#variant]). */
  model?: string
  /** Free-text steer from the user, e.g. "call it after the budget limits". Outranks the prompt. */
  guidance?: string
  signal?: AbortSignal
}

/** Where a proposed name came from, so the launcher can say who suggested it. */
export type BranchNameSource = "declared" | "model" | "prompt" | "fallback"

export type BranchNameProposal = {
  branch: string
  source: BranchNameSource
  /** Set when the model call failed; shown in the launcher so the user knows why it's a guess. */
  error?: string
}

/** Cheap, fast model used to synthesize a branch name from the prompt. */
export const defaultBranchNameModel = "openrouter/deepseek/deepseek-v4.1-flash"

/** Registered so the namer replaces opencode's default coding agent instead of merely appending to it. */
const namerAgentName = "convoy-branch-namer"

// Generous enough for the namer to look up a referenced issue before answering;
// the deterministic fallback still guards the whole thing.
const branchNameTimeoutMs = 60_000
const maxBranchNameLength = 48

/** Conventional-commit types; the branch prefix is always one of these. */
const branchTypes = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"] as const
type BranchType = (typeof branchTypes)[number]
const defaultBranchType: BranchType = "feat"

/**
 * The branch prefixes `convoy spin` derives from a change's own delta-spec
 * operations. `change` is deliberately not a conventional-commit type — it
 * names a branch that only edits existing behavior, which no commit type
 * expresses.
 */
export type ChangePrefix = "feat" | "change" | "fix"

/**
 * The requirement-operation markers a delta spec file may carry, as written
 * by OpenSpec: `## ADDED Requirements`, `## MODIFIED Requirements`,
 * `## REMOVED Requirements`. `RENAMED` counts as a modification of existing
 * requirements, never as an addition.
 */
const deltaOperationPattern = /^\s{0,6}(?:[-*+]\s+|>\s*)?#{0,6}\s*(?:\*\*)?\s*(ADDED|MODIFIED|REMOVED|RENAMED)\b/

/**
 * Extracts the requirement-operation markers from one delta spec body, in
 * order of appearance. Pure so inference is unit-testable without files.
 */
export function deltaOperationsIn(body: string): Array<"ADDED" | "MODIFIED" | "REMOVED"> {
  const out: Array<"ADDED" | "MODIFIED" | "REMOVED"> = []
  for (const line of body.split("\n")) {
    const match = deltaOperationPattern.exec(line)
    if (!match) continue
    const marker = match[1]!
    const op: "ADDED" | "MODIFIED" | "REMOVED" = marker === "RENAMED" ? "MODIFIED" : marker === "ADDED" || marker === "MODIFIED" || marker === "REMOVED" ? marker : "MODIFIED"
    if (!out.includes(op)) out.push(op)
  }
  return out
}

/**
 * The conventional branch prefix for a change, derived deterministically from
 * its own delta specs: any `ADDED` requirement → `feat`, every requirement
 * `MODIFIED` (or `RENAMED`) → `change`, only `REMOVED` → `fix`. Mixed
 * operations with no addition — the ambiguous middle — resolve to `feat`,
 * and a change with no delta specs yet (nothing written under `specs/`) also
 * starts as `feat`. Needs no model and encodes what the author already wrote.
 */
export function inferChangePrefix(deltaBodies: readonly string[]): ChangePrefix {
  const ops = new Set(deltaBodies.flatMap((body) => deltaOperationsIn(body)))
  if (ops.has("ADDED")) return "feat"
  if (ops.size === 1 && ops.has("REMOVED")) return "fix"
  if (ops.size === 1 && ops.has("MODIFIED")) return "change"
  return "feat"
}

/** The deterministic branch name for spinning out a change: `<prefix>/<change-id>`. */
export function branchNameForChange(changeId: string, prefix: string): string {
  return `${prefix}/${changeId}`
}

/**
 * Validates a `--prefix` override. Accepts the change prefixes plus every
 * conventional-commit type, so an operator can spin a docs-only change onto
 * `docs/<id>`; anything else is refused rather than guessed.
 */
export function detectSpinPrefixOverride(value: string): ChangePrefix | BranchType {
  const normalized = value.trim().toLowerCase()
  if (normalized === "feat" || normalized === "change" || normalized === "fix") return normalized
  if (isBranchType(normalized)) return normalized
  throw new Error(`--prefix must be one of: change, ${branchTypes.join(", ")} (got "${value}")`)
}

/**
 * The namer is a registered read-only agent, not a bare `system` string on the
 * default agent: an extra system message leaves opencode's conversational
 * coding persona in charge, which is how a reply ending in "¿Cuál es tu
 * siguiente paso?" once became a branch name. MCP tools from the user's
 * opencode setup are left untouched so issue trackers (Linear, GitHub) stay
 * reachable.
 */
function namerOpencodeConfig(): Config {
  const agent: AgentConfig = {
    description: "Names git branches for convoy worktrees",
    mode: "primary",
    temperature: 0,
    prompt: branchNameSystemPrompt,
    tools: {
      read: true,
      list: true,
      glob: true,
      grep: true,
      webfetch: true,
      write: false,
      edit: false,
      bash: false,
      task: false,
      todoread: false,
      todowrite: false,
      websearch: false,
    },
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
  return {
    agent: { [namerAgentName]: agent },
    permission: { question: "deny" },
  }
}

/**
 * Creates a new git branch checked out in a dedicated worktree, so Convoy runs
 * against an isolated checkout instead of the user's current working tree. The
 * branch name is decided (and confirmed by the user) before this is called.
 * The worktree location is resolved through `resolveWorktreeDir` — repo
 * convention, `defaults.worktreeLocation`, or the built-in default — and the
 * branch was already collision-checked on that same resolved location.
 */
export async function createIsolatedWorktree(input: WorktreeInput): Promise<WorktreeResult> {
  const base = input.baseRef ?? "HEAD"
  // Re-check right before creating: the name was validated in the launcher, and
  // anything could have claimed it since (a parallel convoy, a manual branch).
  const branch = await ensureFreeBranchName(input.branch, input.targetDir)
  const dir = await resolveWorktreeDir(branch, input.targetDir)
  await mkdir(dirname(dir), { recursive: true })
  await addWorktree(dir, branch, base, input.targetDir)
  log.info(`created worktree at ${dir} on branch ${branch}`)
  return { dir, branch }
}

/** Where the worktree for `branch` lives; the directory slug flattens the `type/` prefix. */
export function worktreeDirFor(branch: string): string {
  return join(convoyHome(), "worktrees", slugifyBranch(branch))
}

/** Optional context for worktree-location resolution. */
export type WorktreeLocationContext = {
  /** Pre-loaded merged convoy config; loaded from `targetDir` when omitted. */
  config?: ConvoyConfig
}

/**
 * Substitutes `{repo}`, `{branch}`, and a leading `~` in a worktree-location
 * template. `{repo}` is the repository directory name and `{branch}` the
 * filesystem-safe branch slug. A template without `{branch}` expands to a
 * fixed path; `resolveWorktreeDir` appends the branch slug to those so every
 * branch — and every collision suffix — still gets a directory of its own.
 */
export function expandLocationTemplate(template: string, values: { repo: string; branch: string }): string {
  const expanded = template.replaceAll("{repo}", values.repo).replaceAll("{branch}", values.branch)
  if (expanded === "~") return homedir()
  if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2))
  return expanded
}

/**
 * A repo can document where it wants its worktrees with an explicit marker
 * line (`worktree location: ~/dev/wt/{repo}/{branch}`) in AGENTS.md, then
 * README.md. Only the recognized, machine-readable marker counts — loose prose
 * ("we keep worktrees elsewhere") is never interpreted. The first match wins.
 */
const worktreeMarkerRegex =
  /^\s*(?:[-*+]\s+|>\s*)?(?:\*\*)?\s*(?:worktree[ _-]?location|worktrees?)\s*(?:\*\*)?\s*[:=\u2013\u2014-]\s*(.+)$/i

/** A marker's captured value must be a template or a path, never a sentence. */
function looksLikeLocationValue(value: string): boolean {
  if (/\{(?:repo|branch)\}/.test(value)) return true
  return value.startsWith("~") || /^(?:\/|\.\.?\/)/.test(value)
}

export async function documentedWorktreeConvention(targetDir: string): Promise<string | undefined> {
  for (const name of ["AGENTS.md", "README.md"]) {
    let text: string
    try {
      text = await readFile(join(targetDir, name), "utf8")
    } catch {
      continue
    }
    // Fenced code blocks are examples (a README showing a sample config.yaml),
    // not conventions, so the scan never takes a marker from inside one.
    let inFence = false
    for (const line of text.split("\n")) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const match = worktreeMarkerRegex.exec(line)
      if (!match) continue
      // Strip the trailing "# explanation" (decoration, not part of the path)
      // before backticks so a `` `path` # comment `` marker loses both.
      const value = match[1]!
        .trim()
        .replace(/\s+#.*$/, "")
        .replace(/^`+|`+$/g, "")
        .trim()
      if (value && looksLikeLocationValue(value)) return value
    }
  }
  return undefined
}

/**
 * Whether a candidate location can actually hold a worktree: absolute, not
 * inside the repo itself (`git worktree add` refuses that), and creatable —
 * its nearest existing ancestor is a writable directory. Purely
 * observational: nothing is created here, so the launcher preview and
 * collision probes never mutate the filesystem before a run is confirmed;
 * `createIsolatedWorktree` makes the parent chain once the run is real.
 * Unusable candidates are skipped by `resolveWorktreeDir` for the next one.
 */
async function usableWorktreeLocation(dir: string, targetDir: string): Promise<boolean> {
  if (!isAbsolute(dir)) return false
  // Compare physical paths: a lexical comparison is fooled by a symlinked
  // parent that points into (or out of) the repository.
  const rel = relative(await physicalPath(targetDir), await physicalPath(dir))
  // Inside the repo (or the repo dir itself) is unusable. Only a true parent
  // traversal counts as outside, so a sibling literally named `..x` —
  // `rel === "..x/…"` — is not mistaken for one.
  if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) return false
  // Walk up to the nearest existing ancestor: a regular file anywhere on the
  // chain blocks it, and the missing remainder can only be created when that
  // ancestor is a writable directory.
  let current = dirname(dir)
  for (;;) {
    let info: Stats | null = null
    try {
      info = await stat(current)
    } catch {
      // Not there yet — climb toward the root.
    }
    if (info) {
      if (!info.isDirectory()) return false
      try {
        await access(current, constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * The physical form of `dir`: its deepest existing prefix is resolved with
 * `realpath` (following symlinks) and the not-yet-existing tail is reattached
 * as-is, so a path that does not exist yet can still be compared physically.
 */
async function physicalPath(dir: string): Promise<string> {
  let current = dir
  for (;;) {
    try {
      const real = await realpath(current)
      const tail = relative(current, dir)
      return tail ? join(real, tail) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(dir)
      current = parent
    }
  }
}

/**
 * The single place a worktree path is derived: repo-documented convention,
 * then `defaults.worktreeLocation`, then the built-in default. Every caller —
 * creation, collision checks, the launcher preview, and `finish` lookups —
 * resolves through this so they can never drift onto different paths. A
 * declared or configured candidate that cannot be made usable is skipped.
 */
export async function resolveWorktreeDir(branch: string, targetDir: string, ctx: WorktreeLocationContext = {}): Promise<string> {
  const config = ctx.config ?? (await loadMergedConvoyConfig(targetDir))
  const repo = basename(resolve(targetDir))
  const slug = slugifyBranch(branch)
  const candidates: string[] = []
  const documented = await documentedWorktreeConvention(targetDir)
  if (documented) candidates.push(documented)
  if (config?.defaults.worktreeLocation) candidates.push(config.defaults.worktreeLocation)
  for (const template of candidates) {
    const expanded = expandLocationTemplate(template, { repo, branch: slug })
    // A template without `{branch}` would map every branch — and every
    // collision suffix — onto one directory, so the branch slug is appended
    // and each branch keeps a directory of its own (`~/wt` → `~/wt/<slug>`).
    const candidate = template.includes("{branch}") ? expanded : join(expanded, slug)
    if (await usableWorktreeLocation(candidate, targetDir)) return candidate
  }
  return worktreeDirFor(branch)
}

/**
 * Asks a cheap, read-only model for a short kebab-case branch name derived
 * from the prompt — it may look up referenced issues/tickets first. A name
 * the document already declared is used as-is and never sent to the model,
 * because a paraphraser will "improve" `feat/launcher-compact-mode` into
 * something the user then has to rewrite. Any model failure degrades to a
 * name derived from the prompt itself, so the proposal always says something
 * about the work.
 */
export async function proposeBranchName(input: BranchNameInput): Promise<BranchNameProposal> {
  const trimmed = input.prompt.trim()
  const steer = input.guidance?.trim()
  if (!trimmed && !steer) return { branch: fallbackBranchName(), source: "fallback" }

  const resolved = trimmed ? await resolveNamingPrompt(trimmed, input.targetDir) : ""

  // Guidance outranks the document, so a declared name is only auto-accepted
  // when the user didn't ask for something else.
  if (!steer) {
    const declared = extractDeclaredBranchName(resolved)
    if (declared) return { branch: declared, source: "declared" }
  }

  let error: string | undefined
  try {
    const handle = await startOpencode(namerOpencodeConfig(), AbortSignal.timeout(branchNameTimeoutMs))
    try {
      const reply = await askForBranchName(handle.client, {
        ...input,
        prompt: resolved,
        model: input.model ?? defaultBranchNameModel,
      })
      const branch = readBranchName(reply)
      if (branch) return { branch, source: "model" }
      // Quote the reply like the safety judge does: an unusable answer is the
      // one failure mode that can't be diagnosed from the message alone.
      error = `the namer's reply had no usable branch name: ${truncate(reply, 160)}`
    } finally {
      await handle.close()
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  log.warn(`worktree: couldn't generate an AI branch name (${error}); deriving one from the prompt`)
  const heuristic = heuristicBranchName(steer || resolved || trimmed)
  if (heuristic) return { branch: heuristic, source: "prompt", error }
  return { branch: fallbackBranchName(), source: "fallback", error }
}

export async function askForBranchName(client: OpencodeClient, input: BranchNameInput & { model: string }): Promise<string> {
  const parsedModel = splitModelVariant(input.model)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("branch namer timed out")), branchNameTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let sessionID: string | undefined
  try {
    const session = await client.session.create(
      { directory: input.targetDir, title: "convoy branch namer" },
      { signal: controller.signal },
    )
    if (session.error || !session.data?.id) throw new Error("couldn't open a naming session")
    sessionID = session.data.id

    const response = await client.session.prompt(
      {
        sessionID,
        directory: input.targetDir,
        model: parseModel(parsedModel.model),
        ...(parsedModel.variant ? { variant: parsedModel.variant } : {}),
        agent: namerAgentName,
        // Sent as well as the agent prompt: if the agent name ever fails to
        // resolve, the reply must still follow the contract rather than be a
        // free-form answer from opencode's default persona.
        system: branchNameSystemPrompt,
        tools: { read: true, list: true, glob: true, grep: true, webfetch: true, write: false, edit: false, bash: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: namerMessage(input.prompt, input.guidance) }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("branch namer returned no answer")
    return collectText(response.data.parts)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: input.targetDir })
      } catch {
        // best-effort
      }
    }
  }
}

/** The user's own steer outranks the prompt — it's the whole point of the guidance box. */
export function namerMessage(prompt: string, guidance?: string): string {
  const parts: string[] = []
  const steer = guidance?.trim()
  if (steer) parts.push(`How the user wants it named (this outranks everything below):\n${steer}`)
  const body = prompt.trim()
  if (body) {
    const declared = extractDeclaredBranchName(body)
    if (declared) {
      parts.push(`The document already names the branch. Use this exact name unless the instruction above conflicts:\n${declared}`)
    } else {
      const suggested = heuristicBranchName(body)
      if (suggested) {
        parts.push(
          `Name suggested by the document title (keep this topic; translate to English if needed, do not invent a different subject):\n${suggested}`,
        )
      }
    }
    parts.push(`Prompt:\n${excerpt(body)}`)
  }
  return parts.join("\n\n")
}

const branchNameSystemPrompt = [
  "You name git branches. Read the user's prompt and reply with ONE branch name for the work it",
  "describes. Reply with nothing but a single line of JSON:",
  '{"type": "feat", "name": "add-onboarding-flow"}',
  "",
  `"type" is one of: ${branchTypes.join(", ")}.`,
  '"name" is lowercase kebab-case, 2-5 words, ASCII letters/digits/hyphens only, no slashes.',
  "",
  "Rules:",
  "- When the message opens with a \"How the user wants it named\" block, that instruction wins over",
  "  everything else, including the prompt. Build the name around what it asks for.",
  "- If the message includes a \"The document already names the branch\" block, copy that name",
  "  exactly. Do not paraphrase it.",
  "- Always name it in ENGLISH, even when the prompt is written in another language.",
  "- Prefer the document's own title and Goal. Keep those words. Do not invent synonyms",
  "  (\"reliable\" must not become \"solid\"; \"compact mode\" must not become \"narrow-screen-support\").",
  "- A heading or Goal line is the right source for the name. A question is not — never reply",
  "  with a question or a sentence.",
  "- Never ask the user anything. There is no follow-up turn; a question is a failed answer.",
  "- Never refuse and never explain what you couldn't find. If something the user mentions can't be",
  "  verified from the repo or the tools, name the branch from what they told you anyway — the user",
  "  knows what they meant, and a name you can improve beats no name at all.",
  "- If the prompt references an issue, ticket, or PR (#123, ABC-123, a URL) instead of describing",
  "  the work, look it up first with the tools available to you (issue-tracker tools, webfetch,",
  "  repo files) and name the branch after what the issue is actually about. If the reference",
  "  can't be resolved, use the issue ID itself as the name (e.g. dev-1339).",
  "- Do not explore the repository unless the prompt is only an issue, ticket, URL, or file path",
  "  that you must look up. Name from the text you were given.",
  "- You may investigate before answering, but the LAST line of your reply must be the JSON object",
  "  and nothing else.",
].join("\n")

/**
 * Pulls the branch name out of the namer's reply. The JSON object is the
 * contract; the loose fallbacks below exist because a model that investigated
 * first sometimes narrates, and a narration line is only accepted when it
 * actually looks like a branch name rather than prose.
 */
export function readBranchName(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseNameObject(lines[index]!)
    if (parsed) return parsed
  }
  // A fenced or pretty-printed object spans several lines; try the whole reply.
  const whole = parseNameObject(raw)
  if (whole) return whole

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.replace(/^[`'"]+|[`'"]+$/g, "")
    if (/^[a-z0-9][a-z0-9/_-]*$/i.test(line)) {
      const cleaned = cleanBranchName(line)
      if (cleaned) return cleaned
    }
  }
  return cleanBranchName(lines[lines.length - 1] ?? "")
}

function parseNameObject(text: string): string {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return ""
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return ""
  }
  if (!parsed || typeof parsed !== "object") return ""
  const name = (parsed as { name?: unknown }).name
  if (typeof name !== "string") return ""
  const type = (parsed as { type?: unknown }).type
  const prefix = typeof type === "string" && isBranchType(normalizeBranchType(type)) ? normalizeBranchType(type) : defaultBranchType
  // A namer that ignored "no slashes" and answered "feat/add-x" must not end up
  // as "feat/feat-add-x": the `type` field wins over an embedded prefix.
  const bare = splitBranchType(name.trim()).rest
  return cleanBranchName(`${prefix}/${bare}`)
}

/**
 * Coerces a candidate into a git-safe branch name, or returns "" when there is
 * nothing usable in it.
 *
 * `authored` marks a name a human typed: it keeps whatever prefix (or none)
 * they chose and is never second-guessed. Model output gets the opposite
 * treatment — a conventional `type/` prefix is enforced, and anything that
 * reads like prose is rejected so a conversational reply falls through to the
 * next fallback instead of turning a sentence into a branch.
 */
export function cleanBranchName(raw: string, options: { authored?: boolean } = {}): string {
  const candidate = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "")
  if (!candidate) return ""
  if (!options.authored && looksLikeProse(candidate)) return ""

  const { type, rest } = splitBranchType(candidate)
  const body = kebab(rest)
  if (!body) return ""

  const prefix = type ?? (options.authored ? undefined : defaultBranchType)
  const name = prefix ? `${prefix}/${body}` : body
  const capped = capBranchName(name)
  if (!capped) return ""
  // A leading digit in the name confuses some tooling; the type prefix already
  // covers the prefixed form, so only bare names need the guard.
  return /^[0-9]/.test(capped) ? `task-${capped}` : capped
}

/** Splits an optional leading conventional-commit type off the candidate. */
function splitBranchType(candidate: string): { type?: BranchType; rest: string } {
  const match = /^([a-z]+)\s*[/:]\s*(.+)$/is.exec(candidate)
  if (!match) return { rest: candidate }
  const type = normalizeBranchType(match[1]!)
  if (!isBranchType(type)) return { rest: candidate }
  return { type, rest: match[2]! }
}

/** Common spellings people (and models) actually write, mapped onto the canonical types. */
const branchTypeAliases: Record<string, BranchType> = {
  feature: "feat",
  features: "feat",
  bug: "fix",
  bugfix: "fix",
  hotfix: "fix",
  ref: "refactor",
  doc: "docs",
  tests: "test",
  chores: "chore",
}

function normalizeBranchType(value: string): string {
  const lowered = value.trim().toLowerCase()
  return branchTypeAliases[lowered] ?? lowered
}

function isBranchType(value: string): value is BranchType {
  return (branchTypes as readonly string[]).includes(value)
}

/**
 * Prose is anything that reads like a sentence rather than a name: questions
 * are the giveaway (the namer must never ask), and so is a long word count.
 */
function looksLikeProse(candidate: string): boolean {
  if (/[?¿]/.test(candidate)) return true
  return candidate.split(/\s+/).filter(Boolean).length > 8
}

/** Accents survive as letters instead of collapsing into hyphens: "español" → "espanol". */
function kebab(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Caps the length on a hyphen boundary so names never end mid-word. */
function capBranchName(name: string): string {
  if (name.length <= maxBranchNameLength) return name
  const slash = name.indexOf("/")
  const prefix = slash === -1 ? "" : name.slice(0, slash + 1)
  const body = slash === -1 ? name : name.slice(slash + 1)
  const room = maxBranchNameLength - prefix.length
  if (room <= 0) return prefix.slice(0, maxBranchNameLength).replace(/[-/]+$/, "")
  const clipped = body.slice(0, room)
  const lastHyphen = clipped.lastIndexOf("-")
  // Keep the partial word only when there is no earlier boundary to cut on.
  const trimmed = lastHyphen > 0 ? clipped.slice(0, lastHyphen) : clipped
  return `${prefix}${trimmed}`.replace(/[-/]+$/, "")
}

const stopWords = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "we", "i", "it", "is", "are", "be",
  "that", "this", "should", "would", "must", "new", "add", "make",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "que", "y", "o", "para", "por", "con",
  "en", "al", "se", "su", "sus", "lo", "es", "son", "ser", "como", "mas", "pero", "nos", "me", "te",
])

/**
 * A name the document already chose. Checked before the model is asked, so
 * a paraphrasing model cannot turn `feat/launcher-compact-mode` into a synonym.
 * Only explicit declarations count — scanning for any `type/slug` would pick
 * up code samples.
 */
export function extractDeclaredBranchName(prompt: string): string {
  for (const line of prompt.split("\n")) {
    if (!declaredBranchLabel.test(line)) continue
    const afterLabel = line.replace(declaredBranchLabel, "")
    const value = stripMarkdownDecor(afterLabel).replace(/^[\s:*_\u2013\u2014-]+/, "").trim()
    const cleaned = cleanBranchName(value)
    if (cleaned) return cleaned
  }
  const checkout = /\bgit\s+checkout\s+-b\s+[`'"]?([^\s`'";\\]+)/i.exec(prompt)
  if (checkout?.[1]) {
    const cleaned = cleanBranchName(checkout[1])
    if (cleaned) return cleaned
  }
  return ""
}

const declaredBranchLabel = /\b(?:intended\s+branch\s+name|(?:proposed|suggested|target)\s+branch(?:\s+name)?)\b/i

function stripMarkdownDecor(value: string): string {
  return value.replace(/[`'"*_[\]]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * When the launcher prompt is just a pointer at a plan file, read that file
 * so naming sees the PRD instead of the path. Long pasted prompts are left
 * alone — they may mention a path in passing.
 */
export async function resolveNamingPrompt(prompt: string, targetDir: string): Promise<string> {
  const trimmed = prompt.trim()
  if (!trimmed) return trimmed
  if (trimmed.length > namingPointerMaxChars || trimmed.split("\n").length > namingPointerMaxLines) return trimmed
  return (await readReferencedPromptFile(trimmed, targetDir)) ?? trimmed
}

const namingPointerMaxChars = 400
const namingPointerMaxLines = 3
const namingFileMaxBytes = 512_000

async function readReferencedPromptFile(prompt: string, targetDir: string): Promise<string | undefined> {
  for (const candidate of pathCandidates(prompt)) {
    const resolved = expandUserPath(candidate, targetDir)
    try {
      const info = await stat(resolved)
      if (!info.isFile() || info.size <= 0 || info.size > namingFileMaxBytes) continue
      const text = await readFile(resolved, "utf8")
      if (text.trim()) return text
    } catch {
      // not a readable file at this candidate
    }
  }
  return undefined
}

function pathCandidates(prompt: string): string[] {
  const found: string[] = []
  for (const raw of prompt.split(/\s+/)) {
    const token = raw.replace(/^[`'"]+|[`'":,]+$/g, "")
    if (token && (token.includes("/") || /\.(md|txt|markdown)$/i.test(token))) found.push(token)
  }
  // Last path-like token wins: "implement docs/plans/foo.md".
  return found.reverse()
}

function expandUserPath(value: string, targetDir: string): string {
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  if (isAbsolute(value)) return value
  return resolve(targetDir, value)
}

/**
 * Last resort before a timestamp: names the branch after the prompt's own
 * opening — its first heading or first line — so a failed model call still
 * produces something recognizable instead of `convoy-20260726-a4f2`.
 * Only the opening counts: later `# File:` / `# 1.18.18` lines in a plan are
 * comments, not the title.
 */
export function heuristicBranchName(prompt: string): string {
  const first = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? ""
  const source = stripPlanPrefix(first.replace(/^#+\s*/, ""))
  const words = kebab(source)
    .split("-")
    .filter((word) => word && !stopWords.has(word) && !/^\d+$/.test(word))
    .slice(0, 4)
  if (words.length === 0) return ""
  return cleanBranchName(words.join("-"))
}

/** Drops the "Implementation Plan:" / "PRD —" wrapper so the title itself is what gets named. */
function stripPlanPrefix(value: string): string {
  return value.replace(
    /^(?:implementation\s+plan|plan\s+de\s+implementaci[oó]n|plan\s+conjunto|propuesta(?:\s+de\s+implementaci[oó]n)?|prd)\s*[:\u2013\u2014-]\s*/i,
    "",
  )
}

/** Deterministic fallback so worktree creation never depends on a model being available. */
export function fallbackBranchName(): string {
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `convoy-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${randomSlug(4)}`
}

/**
 * Appends `-2`, `-3`… until neither the branch nor its worktree directory is
 * taken, so re-running a similar prompt doesn't fail `git worktree add` after
 * the run has already been confirmed. The directory check runs on the
 * *resolved* location, so suffixes apply to declared layouts too.
 */
export async function ensureFreeBranchName(branch: string, targetDir: string, limit = 50): Promise<string> {
  // Loaded once: every suffix candidate resolves against the same config.
  const config = await loadMergedConvoyConfig(targetDir)
  for (let suffix = 1; suffix <= limit; suffix++) {
    const candidate = suffix === 1 ? branch : `${branch}-${suffix}`
    if (!(await branchNameTaken(candidate, targetDir, { config }))) return candidate
  }
  return `${branch}-${randomSlug(4)}`
}

/** True when the branch exists or its resolved worktree directory is already on disk. */
export async function branchNameTaken(branch: string, targetDir: string, ctx: WorktreeLocationContext = {}): Promise<boolean> {
  if (await branchExists(branch, targetDir)) return true
  // `git worktree add` refuses a path that already exists, so an orphaned
  // directory from an earlier run counts as taken even without a branch.
  try {
    await stat(await resolveWorktreeDir(branch, targetDir, ctx))
    return true
  } catch {
    return false
  }
}

/** Filesystem-safe directory name for the worktree (flattens the `type/` prefix). */
export function slugifyBranch(branch: string): string {
  return kebab(branch) || `convoy-${randomSlug(6)}`
}

function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

const excerptHead = 900
const excerptTail = 500

/**
 * Long PRDs bury the actual ask in their closing recommendation, so the namer
 * gets both ends of the document rather than only its opening context. Title,
 * Goal, and any declared branch name are prepended so a mid-document
 * "Intended Branch Name" cannot fall into the cut.
 */
export function excerpt(value: string): string {
  const highlights = namingHighlights(value)
  if (value.length <= excerptHead + excerptTail) {
    return highlights && !value.startsWith(highlights) ? `${highlights}\n\n${value}` : value
  }
  const clipped = `${value.slice(0, excerptHead)}\n…\n${value.slice(-excerptTail)}`
  return highlights ? `${highlights}\n\n${clipped}` : clipped
}

function namingHighlights(value: string): string {
  const keep: string[] = []
  let headings = 0
  for (const line of value.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#") && headings < 2) {
      keep.push(trimmed)
      headings += 1
      continue
    }
    if (/(?:intended|proposed|suggested|target)\s+branch|^\*{0,2}goal\*{0,2}\s*:/i.test(trimmed)) {
      keep.push(trimmed)
    }
    if (keep.length >= 6) break
  }
  return keep.join("\n")
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
