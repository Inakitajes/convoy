import { execFile, resolveCommit, currentBranch, detectBaseRef } from "./git"
import { conventionalTypeFromBranch, humanizeBranchSlug } from "./run-title"
import { capSubjectWithin, stripControlBytes } from "./commit-text"
import { pushCommittedRevision } from "./operation-handlers"
import { acknowledgeStep, createOperation, ensureOperationsRoot, recordStepIntent, resolveOperation } from "./operation-journal"
import { repoCommonDir } from "./repo-store"

/**
 * The independent PR operation (change `worktree-control-center`, tasks 5.4–5.6,
 * design D6; gap CC-5): PR composition and creation for an explicitly selected
 * branch, without a run, a feature record, or GitHub gating Git push. The
 * draft describes the WHOLE current branch range against the reviewed base —
 * explicitly selected local proposals and run reports are supplementary
 * context, never the scope. Accepted text and inputs are frozen in an
 * unresolved operation journal before any effect, so a retry reuses them and
 * reconciles uncertain effects (a push that succeeded, a PR whose creation
 * response was lost) instead of duplicating them. A failed lookup is unknown
 * evidence, never permission to create.
 */

export type PrDraft = {
  title: string
  body: string
  /** The commit subjects and diff facts the draft was composed from. */
  facts: { commits: number; subjects: string[] }
}

export type PrScope = {
  /** The hosting repository (`owner/repo`) the PR is created on. */
  hostingRepo: string
  /** The head repository/branch (forks have a different head repo). */
  headRepo: string
  headBranch: string
  baseRepo: string
  baseBranch: string
}

export type PrOperationInput = {
  checkout: string
  base?: string
  /** Operator text always wins over composition. */
  title?: string
  body?: string
  /** Explicit scope overrides; resolved from `gh`/git when omitted. */
  repo?: string
  headRepo?: string
  /** Authorize the disclosed push prerequisite through the same Push operation. */
  push?: boolean
}

export type PrOperationOutcome =
  | { ok: true; pr?: { number: number; url: string; title: string }; pushed?: string; reused: boolean }
  | { ok: false; reason: string }

/** `gh` availability is a fact, not an assumption. */
async function ghAvailable(): Promise<boolean> {
  const result = await execFile("gh", ["--version"], { cwd: process.cwd(), allowFailure: true })
  return result.exitCode === 0
}

/** Resolves `owner/repo` for the checkout through `gh`; unknown when it cannot answer. */
async function resolveHostingRepo(checkout: string): Promise<string | undefined> {
  const result = await execFile("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: checkout, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  const name = result.stdout.trim()
  return name.includes("/") ? name : undefined
}

/** The scoped open-PR lookup: one query, exact head/base scope, tolerant of failure. */
export async function queryOpenPr(scope: PrScope, checkout: string): Promise<{ kind: "known"; pr?: { number: number; url: string; title: string; state: string } } | { kind: "unknown"; reason: string }> {
  if (!(await ghAvailable())) return { kind: "unknown", reason: "the GitHub CLI is not installed or not usable" }
  const result = await execFile(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      scope.hostingRepo,
      "--state",
      "open",
      "--head",
      scope.headBranch,
      "--base",
      scope.baseBranch,
      "--json",
      "number,title,url,state,headRefName,baseRefName",
    ],
    { cwd: checkout, allowFailure: true },
  )
  if (result.exitCode !== 0) {
    return { kind: "unknown", reason: `the open-PR query failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}` }
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string; url: string; state: string }>
    if (!Array.isArray(parsed)) return { kind: "unknown", reason: "the open-PR query returned an unexpected shape" }
    if (parsed.length === 0) return { kind: "known", pr: undefined }
    // An exact head/base scope query can still match several (rare); refuse to
    // guess between them.
    if (parsed.length > 1) {
      return { kind: "unknown", reason: `multiple open PRs match ${scope.headBranch} → ${scope.baseBranch} (${parsed.map((pr) => `#${pr.number}`).join(", ")}) — resolve the ambiguity explicitly` }
    }
    const pr = parsed[0]!
    return { kind: "known", pr: { number: pr.number, url: pr.url, title: pr.title, state: pr.state } }
  } catch (error) {
    return { kind: "unknown", reason: `the open-PR query returned unreadable output: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The deterministic draft (task 5.4): a conventional human-readable title from
 * the branch's own prefix and slug, and a Why/What/How-tested body grounded in
 * the whole reviewed branch range. Missing evidence is disclosed, never
 * invented; operator text always wins.
 */
export async function composePrDraft(input: { checkout: string; base: string; branch: string; title?: string; body?: string }): Promise<PrDraft> {
  if (input.title !== undefined && input.body !== undefined) {
    return { title: input.title, body: input.body, facts: { commits: 0, subjects: [] } }
  }
  const [log, diffStat] = await Promise.all([
    execFile("git", ["log", "--no-merges", "--format=%s", `${input.base}..HEAD`], { cwd: input.checkout, allowFailure: true }),
    execFile("git", ["diff", "--stat", `${input.base}...HEAD`], { cwd: input.checkout, allowFailure: true }),
  ])
  const subjects = log.exitCode === 0 ? log.stdout.split("\n").map((line) => stripControlBytes(line).trim()).filter(Boolean) : []
  const statTail = diffStat.exitCode === 0 ? diffStat.stdout.trim().split("\n").pop() ?? "" : ""
  const type = conventionalTypeFromBranch(input.branch)
  const slug = humanizeBranchSlug(input.branch)
  const prefix = type ? `${type}: ` : ""
  const subject = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : input.branch
  const title = input.title ?? `${prefix}${capSubjectWithin(prefix, subject, 72)}`

  const whatLines = subjects.slice(0, 5).map((subject) => `- ${subject}`)
  if (subjects.length > 5) whatLines.push(`- … and ${subjects.length - 5} more commits`)
  const body =
    input.body ??
    [
      "## Why",
      "Not disclosed in the selected inputs — describe the motivation before merging.",
      "",
      "## What",
      ...(subjects.length > 0 ? whatLines : ["- (no commits found in the reviewed range)"]),
      statTail ? `\nReviewed range \`${input.base}...HEAD\`: ${statTail}` : "",
      "",
      "## How-tested",
      "No validation evidence was selected; testing status is unknown for this range.",
    ]
      .join("\n")
      .trim()
  return { title, body, facts: { commits: subjects.length, subjects: subjects.slice(0, 5) } }
}

/**
 * Runs the reviewed PR operation: freeze → (authorized push) → scoped
 * existing-PR lookup → create. Every effect revalidates the pinned facts; a
 * resolved operation releases its journal, an unresolved one stays recoverable
 * through `convoy worktrees recover`.
 */
export async function runPrOperation(input: PrOperationInput, cwd?: string): Promise<PrOperationOutcome> {
  const checkout = input.checkout
  const branch = await currentBranch(checkout)
  if (!branch) return { ok: false, reason: `checkout ${checkout} has a detached HEAD; a PR needs an attached branch to name the head` }

  // The base: explicit review input, else the repository's detected base as a
  // disclosed suggestion (design D5) — never a silent `main` assumption.
  let base = input.base
  if (!base) {
    const detected = await detectBaseRef(checkout).catch(() => undefined)
    base = detected?.ref
  }
  if (!base) return { ok: false, reason: "no base could be detected — pass --base <local-branch> naming the PR's base" }
  const baseOid = await resolveCommit(base, checkout)
  if (!baseOid) return { ok: false, reason: `base ref "${base}" does not resolve to a commit` }
  const headOid = await resolveCommit("HEAD", checkout)
  if (!headOid) return { ok: false, reason: "HEAD has no commit to publish" }

  // Scope: explicit review inputs, else resolved from `gh` — a failed
  // resolution is unknown evidence, never a guessed owner/repo.
  const hostingRepo = input.repo ?? (await resolveHostingRepo(checkout))
  if (!hostingRepo) {
    return { ok: false, reason: "the hosting repository could not be resolved — pass --repo <owner/repo> or authenticate `gh`" }
  }
  const headRepo = input.headRepo ?? hostingRepo
  const scope: PrScope = { hostingRepo, headRepo, headBranch: branch, baseRepo: hostingRepo, baseBranch: base }

  // Freeze the accepted inputs before any effect (task 5.5): the journal
  // carries the composed text, the pinned OIDs, and the requested steps.
  const draft = await composePrDraft({ checkout, base, branch, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}) })
  const commonDir = await repoCommonDir(checkout)
  let operationId: string | undefined
  if (commonDir) {
    try {
      await ensureOperationsRoot(commonDir)
      const created = await createOperation(commonDir, {
        kind: "pr",
        intent: { ...scope, base, headOid, baseOid, title: draft.title, body: draft.body, push: input.push === true },
        steps: [...(input.push ? ["push" as const] : []), "create" as const],
      })
      if (created.ok) {
        operationId = created.operation.operationId
        for (const step of created.operation.steps) {
          await recordStepIntent(commonDir, operationId, step.id, step.id === "push" ? { remote: "origin", remoteRef: branch, oid: headOid } : { ...scope, title: draft.title })
        }
      }
    } catch {
      // A journal that cannot be written is disclosed below; the operation
      // still refuses to create without its frozen inputs when recovery data
      // is required — but a first successful run may proceed and report.
    }
  }

  // 1. The disclosed push prerequisite, only when explicitly authorized.
  let pushed: string | undefined
  if (input.push) {
    const outcome = await pushCommittedRevision({ checkout, ...(commonDir ? { commonDir } : { commonDir: checkout }), remote: "origin", refspec: `${branch}:${branch}` })
    if (!outcome.ok) {
      return { ok: false, reason: `the authorized push did not complete: ${outcome.blockers.map((blocker) => blocker.reason).join("; ") || outcome.reason || "rejected"}` }
    }
    pushed = `${branch}:${branch}`
    if (commonDir && operationId) await acknowledgeStep(commonDir, operationId, "push", { pushed }).catch(() => {})
  }

  // 2. The scoped existing-PR lookup: a failed query is unknown, never
  //    permission to create (task 5.5).
  const existing = await queryOpenPr(scope, checkout)
  if (existing.kind === "unknown") {
    return { ok: false, reason: `PR state is unknown: ${existing.reason}${operationId ? ` — the accepted text is frozen in operation ${operationId}; retry after resolving the query` : ""}` }
  }
  if (existing.pr) {
    // Reuse, never duplicate.
    if (commonDir && operationId) {
      await acknowledgeStep(commonDir, operationId, "create", { reused: existing.pr.number }).catch(() => {})
      await resolveOperation({ commonDir, operationId, gitCwd: checkout, outcome: "resolved" }).catch(() => {})
    }
    return { ok: true, pr: { number: existing.pr.number, url: existing.pr.url, title: existing.pr.title }, ...(pushed ? { pushed } : {}), reused: true }
  }

  // 3. Create with the frozen text.
  if (!(await ghAvailable())) {
    return { ok: false, reason: `the GitHub CLI is not installed — push remains available${operationId ? `; the accepted text is frozen in operation ${operationId}` : ""}` }
  }
  const created = await execFile(
    "gh",
    ["pr", "create", "--repo", hostingRepo, "--base", base, "--head", branch, "--title", draft.title, "--body", draft.body],
    { cwd: checkout, allowFailure: true },
  )
  if (created.exitCode !== 0) {
    const detail = (created.stderr || created.stdout).trim().slice(0, 300)
    return { ok: false, reason: `PR creation failed: ${detail}${operationId ? ` — the accepted text is frozen in operation ${operationId}; retry reconciles before creating` : ""}` }
  }
  const url = created.stdout.trim().split("\n").find((line) => line.startsWith("http")) ?? ""
  if (commonDir && operationId) {
    await acknowledgeStep(commonDir, operationId, "create", { url }).catch(() => {})
    await resolveOperation({ commonDir, operationId, gitCwd: checkout, outcome: "resolved" }).catch(() => {})
  }
  return { ok: true, ...(url ? { pr: { number: 0, url, title: draft.title } } : {}), ...(pushed ? { pushed } : {}), reused: false }
}
