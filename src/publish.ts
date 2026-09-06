import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { capSubjectWithin, maxCommitSubjectLength } from "./commit-text"
import { execFile } from "./git"
import { branchIdFromBranch, openspecDirName, stripYamlFrontmatter, titleFromProposal } from "./openspec"
import { conventionalTypeFromBranch, humanizeBranchSlug } from "./run-title"

/**
 * The deliberate `Create pull request` publication action (capability
 * run-finalization, design D5): the only publication surface left after the
 * manual finish was retired. On explicit selection it revalidates the current
 * branch state, performs one normal push to a disclosed destination with an
 * explicit refspec, then locates an existing open PR or creates one — never
 * force-pushing, deleting branches, or removing worktrees. A published
 * uncompacted branch is legitimate, so nothing here inspects compaction
 * success beyond refusing to publish while a transaction needs recovery.
 *
 * The PR text is composed synchronously from state persisted before
 * publication (capability run-titles, design D4/D5): a conventional
 * `type: subject` title and a Why / What / How-tested body, each section
 * falling back mechanically when its source is absent. Composition never
 * blocks publication and never needs a model; equal persisted state composes
 * equal text, so a failed `gh pr create` retry reproduces the same PR.
 *
 * Unavailable states are disclosed with remediation, never guessed around:
 * a dirty/detached/base worktree, no remotes, ambiguous remotes without an
 * upstream, a missing `gh` binary, or missing authentication all stop before
 * the push. Push and PR creation are separate outcomes: a failed `gh pr
 * create` after a successful push is retryable without a duplicate PR, because
 * the retry locates the existing one first.
 */

export type RunResult = { stdout: string; stderr: string; exitCode: number }
export type PublishRunner = (command: string, args: string[], options?: { allowFailure?: boolean }) => Promise<RunResult>

/** The well-known trunk names a feature branch is never published from. */
const baseBranchNames = new Set(["main", "master", "develop", "trunk"])

export type CreatePublishSeamInput = {
  cwd: string
  /** The run workspace, when known; its summary seeds the PR body, its metadata gates publication during recovery. */
  runDir?: string
  /** Injectable subprocess runner for hermetic tests. */
  run?: PublishRunner
}

export function createPublishSeam(input: CreatePublishSeamInput) {
  const cwd = input.cwd
  const run: PublishRunner =
    input.run ??
    (async (command, args, options) => {
      try {
        return await execFile(command, args, { cwd, allowFailure: options?.allowFailure ?? false })
      } catch (error) {
        // execFile throws on failure without allowFailure; surface it through the
        // same shape a failure return would take.
        return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
      }
    })

  return {
    /**
     * Resolves and discloses repository, branch, destination remote, and PR
     * base, or explains exactly what is missing (D5: no guessed pushes).
     */
    async prepare(): Promise<{ ok: true; plan: { branch: string; remote: string; base: string } } | { ok: false; message: string }> {
      const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).stdout.trim()
      if (!branch) {
        return { ok: false, message: "HEAD is detached; check out the run's branch before publishing" }
      }
      if (baseBranchNames.has(branch)) {
        return { ok: false, message: `"${branch}" is a base branch; publication is only offered for feature branches` }
      }
      if ((await run("git", ["status", "--porcelain"])).stdout.trim() !== "") {
        return { ok: false, message: "the working tree has uncommitted changes; commit or stash them before publishing" }
      }

      const remotes = (await run("git", ["remote"], { allowFailure: true })).stdout.split("\n").map((name) => name.trim()).filter(Boolean)
      if (remotes.length === 0) {
        return { ok: false, message: "the repository has no configured remote; add one (git remote add origin <url>) before publishing" }
      }

      // Destination: the branch's own upstream remote when it has one; otherwise
      // the unique repository remote; several remotes without an upstream stop
      // for an explicit choice instead of a guessed push.
      const upstream = (await run("git", ["rev-parse", "--quiet", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], { allowFailure: true })).stdout.trim()
      let remote: string | undefined
      if (upstream && upstream !== `${branch}@{upstream}` && upstream.includes("/")) {
        remote = upstream.split("/")[0]
      } else if (remotes.length === 1) {
        remote = remotes[0]
      } else {
        return {
          ok: false,
          message: `several remotes are configured (${remotes.join(", ")}) and the branch has no upstream; set one (git push -u <remote> ${branch}) before publishing`,
        }
      }

      // The PR base is the destination's default branch.
      const remoteHead = (await run("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { allowFailure: true })).stdout.trim()
      const base = remoteHead.startsWith(`${remote}/`) ? remoteHead.slice(remote.length + 1) : "main"

      const gh = await ghGuidance(run)
      if (!gh.ok) return gh

      const recovery = await recoveryGate(input.runDir)
      if (!recovery.ok) return recovery

      // Feature-backed publication revalidates the reviewed feature link
      // immediately before the push (capability run-finalization, task 5.2):
      // the run's durable feature link must still verify — the same feature,
      // association revision, and branch. A historical run whose path was
      // reused by another feature never publishes the replacement branch.
      const featureGate = await featureLinkGate(input.runDir, cwd)
      if (!featureGate.ok) return featureGate

      return { ok: true, plan: { branch, remote, base } }
    },

    /**
     * One normal push, then PR location/creation. A non-fast-forward rejection
     * stops with the remote's message — never a force. A PR failure after a
     * landed push says exactly that, and the retry reuses the push because the
     * existing-PR check runs before creation.
     */
    async apply(plan: { branch: string; remote: string; base: string }): Promise<{ ok: true; outcome: { pushed: boolean; url?: string } } | { ok: false; message: string }> {
      const push = await run("git", ["push", plan.remote, `${plan.branch}:${plan.branch}`], { allowFailure: true })
      if (push.exitCode !== 0) {
        const detail = (push.stderr || push.stdout).trim()
        return { ok: false, message: `push to ${plan.remote}/${plan.branch} was rejected; nothing was published${detail ? `: ${detail}` : ""}` }
      }

      const existing = await run("gh", ["pr", "list", "--head", plan.branch, "--state", "open", "--json", "url", "--limit", "1"], { allowFailure: true })
      if (existing.exitCode === 0) {
        const url = parsePrListUrl(existing.stdout)
        if (url) return { ok: true, outcome: { pushed: true, url } }
      }

      const body = await composePrText({ cwd, runDir: input.runDir, branch: plan.branch })
      const created = await run(
        "gh",
        ["pr", "create", "--head", plan.branch, "--base", plan.base, "--title", body.title, "--body", body.text],
        { allowFailure: true },
      )
      if (created.exitCode !== 0) {
        const detail = (created.stderr || created.stdout).trim()
        return {
          ok: false,
          message: `the branch was pushed to ${plan.remote}/${plan.branch}, but creating the pull request failed${detail ? `: ${detail}` : ""}; retry to locate or create it without pushing again unnecessarily`,
        }
      }
      const url = parsePrUrl(created.stdout) ?? parsePrUrl(created.stderr)
      return { ok: true, outcome: { pushed: true, ...(url ? { url } : {}) } }
    },
  }
}

function parsePrUrl(stdout: string): string | undefined {
  return /https:\/\/\S+\/pull\/\S+/.exec(stdout)?.[0]?.replace(/[)\].,='"`]+$/, "")
}

/** The `gh pr list` JSON payload's first URL, or a URL quoted plainly in its output. */
function parsePrListUrl(stdout: string): string | undefined {
  try {
    const rows = JSON.parse(stdout) as Array<{ url?: string }>
    const url = rows.find((row) => typeof row.url === "string" && row.url)?.url
    if (url) return url
  } catch {
    // fall through to the plain-text scan
  }
  return parsePrUrl(stdout)
}

/** A run whose compaction transaction needs recovery must not publish (design D4). */
async function recoveryGate(runDir: string | undefined): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!runDir || runDir === "/") return { ok: true }
  let metadata: { finalization?: { recoveryRequired?: boolean; reason?: string } }
  try {
    metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"))
  } catch {
    return { ok: true }
  }
  if (metadata.finalization?.recoveryRequired === true) {
    return {
      ok: false,
      message: `this run's compaction transaction needs recovery before publication${metadata.finalization.reason ? `: ${metadata.finalization.reason}` : ""}`,
    }
  }
  return { ok: true }
}

/**
 * The feature-link gate (task 5.2): a feature-backed run's durable link is
 * revalidated against the live repository right before publication. The
 * resolution is lazy so no-spec runs never touch the lifecycle module.
 */
async function featureLinkGate(runDir: string | undefined, cwd: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!runDir || runDir === "/") return { ok: true }
  let metadata: { feature?: { featureId: string; associationRevision: number; branch: string; baseRef: string; contracts: readonly string[]; repositoryId: string; worktreeDir?: string } }
  try {
    metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"))
  } catch {
    return { ok: true }
  }
  const link = metadata.feature
  if (!link) return { ok: true }
  const { revalidateFeatureLink } = await import("./feature-lifecycle/launch")
  try {
    await revalidateFeatureLink({ cwd, link })
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `publication refuses: the run's reviewed feature context no longer verifies — ${detail}. Publication never pushes the branch now occupying the historical path.`,
    }
  }
}

/** `gh` availability and authentication, each with concrete remediation (D5). */
async function ghGuidance(run: PublishRunner): Promise<{ ok: true } | { ok: false; message: string }> {
  const version = await run("gh", ["--version"], { allowFailure: true })
  if (version.exitCode !== 0) {
    return {
      ok: false,
      message: "the GitHub CLI (gh) is not installed; install it from https://cli.github.com, or publish manually with: git push <remote> <branch> && gh pr create",
    }
  }
  const auth = await run("gh", ["auth", "status"], { allowFailure: true })
  if (auth.exitCode !== 0) {
    return { ok: false, message: "the GitHub CLI is not authenticated; run `gh auth login` before publishing" }
  }
  return { ok: true }
}

/** Caps for the composed body sections (design D4): each keeps the body a summary. */
const whyMaxChars = 600
const whatMaxChars = 2400
const howTestedMaxChars = 1600
const howTestedReportMaxChars = 800

/** The disclosed line a section shows when every one of its sources is absent. */
const notDocumented = "Not documented in the sources available to this run."

/** The distilled-recap report names: the built-in pipelines write `run-report` (agent alias), a step named after the agent writes `run-reporter`. */
const recapReportNames = ["reports/run-report.md", "reports/run-reporter.md"] as const

/**
 * The PR text, composed synchronously from persisted context only (capability
 * run-titles, design D4/D5): a conventional `type: subject` title and a Why /
 * What / How-tested body, each source optional, so composition completes even
 * when a document is absent and equal state composes equal text.
 */
async function composePrText(input: { cwd: string; runDir?: string; branch: string }): Promise<{ title: string; text: string }> {
  const changeId = branchIdFromBranch(input.branch)
  const proposal = changeId ? await readProposal(input.cwd, changeId) : undefined

  // Title: the branch's conventional prefix supplies the type (never a
  // fabricated one) and the change's proposal title — the same
  // `titleFromProposal` reader the control board uses — else the humanized
  // slug supplies the subject. The prompt's first line is never consulted.
  const proposalTitle = proposal && changeId ? titleFromProposal(proposal.body, changeId) : ""
  const subject = proposalTitle || humanizeBranchSlug(input.branch) || input.branch
  const type = conventionalTypeFromBranch(input.branch)
  // The whole line — prefix and subject together — stays inside the shared
  // 72-column budget, shortened at a word boundary.
  const prefix = type ? `${type}: ` : ""
  const title = `${prefix}${capSubjectWithin(prefix, subject, maxCommitSubjectLength)}`

  const sections: string[] = []

  // Why: the proposal's Why section; else the prompt document's opening
  // paragraph — the operator's stated intent is the why for non-change runs.
  const why = (proposal ? proposalWhySection(proposal.body) : "") || firstParagraph(await readOptional(input.runDir, "prd.md"))
  sections.push(renderSection("Why", why ? capProse(why, whyMaxChars) : notDocumented))

  // What: the run's distilled recap; else the compacted run commit's message
  // body; else the SUMMARY.md excerpt as the historical last fallback. Embedded
  // content nests under the section heading so its own headings can never
  // outrank the composed structure.
  const what =
    (await readRecapReport(input.runDir)) ??
    (await finalizationMessageBody(input.runDir)) ??
    summaryExcerpt(await readOptional(input.runDir, "SUMMARY.md"))
  sections.push(renderSection("What", what ? capProse(nestUnder(what, 2), whatMaxChars) : notDocumented))

  // How tested: the reports of test/validation steps; when none exists, say
  // so explicitly rather than implying coverage.
  const howTested = await composeHowTested(input.runDir)
  sections.push(renderSection("How tested", howTested ?? "No test or validation report was produced by this run."))

  return { title, text: sections.join("\n\n") }
}

/** The change's proposal body read against the target checkout; `undefined` when absent or unreadable — never a blocker. */
async function readProposal(cwd: string, changeId: string): Promise<{ body: string } | undefined> {
  try {
    return { body: await readFile(join(cwd, openspecDirName, "changes", changeId, "proposal.md"), "utf8") }
  } catch {
    return undefined
  }
}

/** The distilled-recap report from the run workspace; `undefined` when the pipeline produced none. */
async function readRecapReport(runDir: string | undefined): Promise<string | undefined> {
  for (const name of recapReportNames) {
    const body = await readOptional(runDir, name)
    if (body) return body
  }
  return undefined
}

/** The proposal's `## Why` section text, up to the next heading; empty when the proposal carries none. */
function proposalWhySection(proposalBody: string): string {
  const lines = stripYamlFrontmatter(proposalBody).split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+why\b/i.test(line.trim()))
  if (start === -1) return ""
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line.trim()))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n").trim()
}

/** The prompt document's opening paragraph — its stated intent — with heading markers stripped. */
function firstParagraph(prompt: string | undefined): string {
  if (!prompt) return ""
  const lines: string[] = []
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      if (lines.length > 0) break
      continue
    }
    lines.push(line.replace(/^#+\s*/, ""))
  }
  return lines.join(" ")
}

/** The compacted run commit's message body (subject line removed) from the durable finalization record. */
async function finalizationMessageBody(runDir: string | undefined): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  let metadata: { finalization?: { producedMessage?: unknown } }
  try {
    metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"))
  } catch {
    return undefined
  }
  const message = typeof metadata.finalization?.producedMessage === "string" ? metadata.finalization.producedMessage : ""
  const body = message.split("\n").slice(1).join("\n").trim()
  return body || undefined
}

/** The current SUMMARY.md excerpt (first 40 lines) — the historical last fallback for What. */
function summaryExcerpt(summary: string | undefined): string | undefined {
  const text = summary?.trim()
  if (!text) return undefined
  return text.split("\n").slice(0, 40).join("\n")
}

/** The capped reports of test/validation steps (step-name substring, design D4); `undefined` when the run produced none. */
async function composeHowTested(runDir: string | undefined): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  let names: string[]
  try {
    names = (await readdir(join(runDir, "reports"))).filter((name) => name.endsWith(".md") && !name.endsWith(".raw.md"))
  } catch {
    return undefined
  }
  const steps = names.filter((name) => /test|validator/i.test(name.slice(0, -".md".length))).sort()
  const parts: string[] = []
  for (const name of steps) {
    const body = await readOptional(runDir, join("reports", name))
    if (!body) continue
    parts.push(`### ${name.slice(0, -".md".length)}\n\n${capProse(nestUnder(body, 3), howTestedReportMaxChars)}`)
  }
  if (parts.length === 0) return undefined
  return capProse(parts.join("\n\n"), howTestedMaxChars)
}

function renderSection(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`
}

/** Caps prose at `max` characters, preferring a word boundary and marking the cut. */
function capProse(value: string, max: number): string {
  const text = value.trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const boundary = cut.lastIndexOf(" ")
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

/**
 * Nests embedded Markdown under the heading that quotes it: every heading is
 * shifted down uniformly so the shallowest one sits one level below `under`
 * (content quoted under `##` starts at `###`, under `###` at `####`), keeping
 * relative structure. Fenced code is never rewritten: per CommonMark a fence
 * opens with at least three identical fence characters (a backtick fence's
 * info string cannot contain a backtick) and closes only with the same
 * character, at least the opening length, and nothing but whitespace after —
 * so a ``` example inside a ```` fence stays code. Content without headings —
 * or already nested deep enough — passes through verbatim.
 */
function nestUnder(markdown: string, under: number): string {
  type Fence = { char: string; length: number }
  const headingOf = (line: string): number | undefined => {
    const heading = /^(#{1,6})(?:\s|$)/.exec(line)
    return heading?.[1].length
  }
  const openerOf = (line: string): Fence | undefined => {
    const opener = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!opener) return undefined
    const run = opener[1]!
    // A backtick fence's info string cannot contain a backtick (CommonMark).
    if (run[0] === "`" && opener[2]!.includes("`")) return undefined
    return { char: run[0]!, length: run.length }
  }
  const closes = (line: string, fence: Fence): boolean =>
    new RegExp(`^\\s{0,3}${fence.char}{${fence.length},}\\s*$`).test(line)

  // Classify once: for each line, the heading level it would contribute —
  // `undefined` for fence lines and fence content, which stay verbatim.
  let fence: Fence | undefined
  const headingLevels = markdown.split("\n").map((line) => {
    if (fence) {
      if (closes(line, fence)) fence = undefined
      return undefined
    }
    const opener = openerOf(line)
    if (opener) {
      fence = opener
      return undefined
    }
    return headingOf(line)
  })

  const shallowest = headingLevels.reduce<number>((min, level) => (level ? Math.min(min, level) : min), Number.POSITIVE_INFINITY)
  const shift = Number.isFinite(shallowest) ? Math.max(0, under + 1 - shallowest) : 0
  if (shift === 0) return markdown
  return markdown
    .split("\n")
    .map((line, index) => {
      const level = headingLevels[index]
      if (!level) return line
      return `${"#".repeat(Math.min(6, level + shift))}${line.slice(level)}`
    })
    .join("\n")
}

async function readOptional(runDir: string | undefined, file: string): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  try {
    return await readFile(join(runDir, file), "utf8")
  } catch {
    return undefined
  }
}
