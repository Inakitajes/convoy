import { resolveCommit, branchUpstream, execFile, commitAsUser, statusPorcelain, findWorktreeDirForBranch, currentBranch, detectBaseRef } from "./git"
import { observeBaseDivergence, observeTreeEquality } from "./worktree-observations"
import { listWorktrees, type WorktreeInventoryEntry } from "./worktree-inventory"
import { readCheckoutActiveChanges, readCheckoutArchives, readCheckoutCanonicalSpecs } from "./checkout-openspec"
import { repoCommonDir } from "./repo-store"
import { requireAgreeingSelectors } from "./worktree-target"
import { reviewOperation, executeReviewed, removeRegisteredWorktree, pushCommittedRevision, assertNonForceRefspec, type ExecutionOutcome } from "./operation-handlers"
import type { OperationInspection } from "./operation-guards"
import { squashToBase } from "./worktree-squash"
import { landViaGitHub, isHostedCloseOperation, hostedOperationInputs, reconcilePendingHostedCloses } from "./close-hosted"
import { readOperation, listPendingOperations, type OperationRecord } from "./operation-journal"
import { recoverOperation, type ReconcileProbe, type RecoveryConsent } from "./operation-recovery"
import { reconcileStepReality } from "./operation-reconcile"
import { openspecDirName } from "./openspec"
import { resolve, join } from "node:path"
import { readFile, readdir, stat } from "node:fs/promises"
import { stripControlBytes } from "./commit-text"
import type { TuiRoute } from "./tui-session"
import type { CloseTui } from "./close-tui"
import type { CloseEvent, CloseLandingDecision, CloseMessageProposal, HostedMergeFacts } from "./close-events"

/**
 * The `convoy worktrees` command surface (change `worktree-control-center`,
 * task 7.8, design D4): the worktree control center's CLI entry points. Every
 * mutating subcommand reviews through the shared operation guards, revalidates
 * at execution time, and reports blockers with remediation — the CLI is one
 * entry point onto the same seam the TUI menus use, never an independent
 * decision path. Destructive headless commands require explicit targets and
 * never fall back to the launch checkout.
 */

export function worktreesHelp(): string {
  return `convoy worktrees — the worktree control center

Usage:
  convoy worktrees                                   # inventory of every registered checkout
  convoy worktrees new                               # describe, review, create a worktree
  convoy worktrees fetch --worktree <path> --remote <name>
  convoy worktrees sync --worktree <path> --base <ref>
  convoy worktrees push --worktree <path> [--remote <name> --ref <local>:<remote>]
  convoy worktrees pr --worktree <path> [--base <ref>] [--repo <owner/repo>]
                                     [--title <text> --body <text>] [--push]
  convoy worktrees run --worktree <path> [--change <id> ... | --manual]
  convoy worktrees archive --worktree <path> --change <id> [--change <id> ...]
  convoy worktrees squash --worktree <path> --base <local-branch> [--message <text>]
  convoy worktrees close --worktree <path> --base <local-branch> [--change <id> ...]
                         [--message <text>] [--local-landing]
  convoy worktrees remove --worktree <path> [--force]
  convoy worktrees delete-branch --branch <name> [--force --expect <oid>]
  convoy worktrees recover --operation <id> [--continue | --cancel]
  convoy worktrees cleanup-legacy [--confirm]

Every action targets the explicitly selected checkout (--worktree <path>) and
revalidates it immediately before any effect. Push publishes with a normal
non-force update only. PR composition describes the WHOLE current branch range
against the reviewed base; accepted text is frozen before any effect and a
retry reconciles uncertain pushes or creations instead of duplicating them.
Squash lands the WHOLE reviewed branch as one commit on the base — selecting
changes controls what close archives, never the squash scope. Close composes
sync (as needed), archive of the explicitly selected changes, and that landing.
Without a linked open pull request, nothing is pushed or merged on a hosting
service: the landing is a local squash and push, worktree removal, and branch
deletion stay separate actions. When close detects exactly one open PR for the
branch through usable GitHub evidence, the landing is hosted instead: close
pushes the branch (non-force), asks GitHub to squash-merge that PR with the
reviewed message, and fast-forwards the local base to GitHub's squash commit —
the remote steps are disclosed before any effect, and --local-landing keeps
the whole landing local. Worktree removal keeps its branch by default and is
deliberately conservative: it blocks on uncommitted/untracked/ignored content,
submodule-local state, locks, and the main/process checkout. --force bypasses
only the content blockers (it never removes the main checkout, the current
checkout, a locked or unverified registration, or unknown state). Branch
deletion is a separate action: the safe form uses Git's own unmerged-refusal;
--force is explicit destructive consent that must also name the exact reviewed
tip with the full 40-character --expect <oid>, and the deletion is refused if
the branch moved after review.`
}

export type WorktreesCommand =
  | { kind: "inventory" }
  | { kind: "new"; description: string; branch?: string; base?: string; destination?: string }
  | { kind: "fetch"; worktree: string; remote: string }
  | { kind: "sync"; worktree: string; base: string }
  | { kind: "push"; worktree: string; remote?: string; refspec?: string }
  | { kind: "pr"; worktree: string; base?: string; repo?: string; headRepo?: string; title?: string; body?: string; push: boolean }
  | { kind: "run"; worktree: string; changes: string[]; manual: boolean }
  | { kind: "archive"; worktree: string; changes: string[]; allowIncomplete?: boolean }
  | { kind: "squash"; worktree: string; base: string; message?: string }
  | { kind: "close"; worktree: string; base: string; changes: string[]; message?: string; localLanding?: boolean }
  | { kind: "remove"; worktree: string; force: boolean }
  | { kind: "delete-branch"; branch: string; force: boolean; expect?: string }
  | { kind: "recover"; operationId: string; consent: RecoveryConsent }
  | { kind: "cleanup-legacy"; confirm: boolean }

export function parseWorktreesArgs(argv: string[]): WorktreesCommand {
  const sub = argv[0]
  if (sub === undefined || sub === "--help" || sub === "-h") throw worktreesUsage(worktreesHelp())

  const flags = new Map<string, string[]>()
  // `new` takes the work description as free positional words; every other
  // subcommand is flag-only.
  const positionals: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith("--")) {
      if (sub === "new") positionals.push(arg)
      else throw worktreesUsage(`unexpected argument "${arg}"`)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      flags.set(arg, flags.get(arg) ?? [])
      continue
    }
    flags.set(arg, [...(flags.get(arg) ?? []), value])
    index += 1
  }
  const single = (name: string): string | undefined => flags.get(name)?.[0]
  const requireSingle = (name: string): string => {
    const value = single(name)
    if (value === undefined) throw worktreesUsage(`missing required flag ${name} <value>`)
    return value
  }
  const unknownFlags = [...flags.keys()].filter((name) => !knownFlags.has(name))
  if (unknownFlags.length > 0) throw worktreesUsage(`unknown flag(s): ${unknownFlags.join(", ")}`)

  switch (sub) {
    case "new": {
      const description = positionals.join(" ").trim()
      return {
        kind: "new",
        description,
        ...(single("--branch") ? { branch: single("--branch") } : {}),
        ...(single("--base") ? { base: single("--base") } : {}),
        ...(single("--destination") ? { destination: single("--destination") } : {}),
      }
    }
    case "fetch":
      return { kind: "fetch", worktree: requireSingle("--worktree"), remote: requireSingle("--remote") }
    case "sync":
      return { kind: "sync", worktree: requireSingle("--worktree"), base: requireSingle("--base") }
    case "push":
      return { kind: "push", worktree: requireSingle("--worktree"), ...(single("--remote") ? { remote: single("--remote") } : {}), ...(single("--ref") ? { refspec: single("--ref") } : {}) }
    case "pr":
      return {
        kind: "pr",
        worktree: requireSingle("--worktree"),
        ...(single("--base") ? { base: single("--base") } : {}),
        ...(single("--repo") ? { repo: single("--repo") } : {}),
        ...(single("--head-repo") ? { headRepo: single("--head-repo") } : {}),
        ...(single("--title") ? { title: single("--title") } : {}),
        ...(single("--body") ? { body: single("--body") } : {}),
        push: flags.has("--push"),
      }
    case "run": {
      const changes = flags.get("--change") ?? []
      const manual = flags.has("--manual")
      if (changes.length === 0 && !manual) {
        throw worktreesUsage("a headless run needs an explicit selection: pass --change <id> (repeatable) or --manual for an explicit no-change run")
      }
      return { kind: "run", worktree: requireSingle("--worktree"), changes, manual }
    }
    case "archive": {
      const changes = flags.get("--change") ?? []
      if (changes.length === 0) throw worktreesUsage("archive needs at least one --change <id> (an empty archive set is a close-review decision, not an archive command)")
      return { kind: "archive", worktree: requireSingle("--worktree"), changes, ...(flags.has("--allow-incomplete") ? { allowIncomplete: true } : {}) }
    }
    case "squash":
      return { kind: "squash", worktree: requireSingle("--worktree"), base: requireSingle("--base"), ...(single("--message") ? { message: single("--message") } : {}) }
    case "close":
      return {
        kind: "close",
        worktree: requireSingle("--worktree"),
        base: requireSingle("--base"),
        changes: flags.get("--change") ?? [],
        ...(single("--message") ? { message: single("--message") } : {}),
        ...(flags.has("--local-landing") ? { localLanding: true } : {}),
      }
    case "remove":
      return { kind: "remove", worktree: requireSingle("--worktree"), force: flags.has("--force") }
    case "delete-branch": {
      const force = (flags.get("--force") ?? []).length > 0
      return { kind: "delete-branch", branch: requireSingle("--branch"), force, ...(single("--expect") ? { expect: single("--expect") } : {}) }
    }
    case "recover": {
      const consent: RecoveryConsent = flags.has("--continue") ? "continue" : flags.has("--cancel") ? "cancel" : "inspect"
      return { kind: "recover", operationId: requireSingle("--operation"), consent }
    }
    case "cleanup-legacy":
      return { kind: "cleanup-legacy", confirm: flags.has("--confirm") }
    default:
      throw worktreesUsage(`unknown subcommand "${sub}"`)
  }
}

const knownFlags = new Set(["--worktree", "--remote", "--ref", "--base", "--change", "--branch", "--force", "--expect", "--operation", "--continue", "--cancel", "--message", "--repo", "--head-repo", "--title", "--body", "--push", "--manual", "--destination", "--confirm", "--allow-incomplete", "--local-landing"])

function worktreesUsage(reason: string): Error {
  return new Error(`${reason}\n\n${worktreesHelp()}`)
}

/** The repository context every subcommand runs against. */
type RepoContext = { cwd: string; commonDir: string }

async function repoContext(cwd?: string): Promise<RepoContext> {
  const dir = cwd ?? process.cwd()
  const commonDir = await repoCommonDir(dir)
  if (!commonDir) throw new Error("not a git repository — `convoy worktrees` operates on the current repository")
  return { cwd: dir, commonDir }
}

/** Runs one subcommand; every failure path exits non-zero with its reason. `cwd` defaults to the process working directory (injectable for tests). */
export async function runWorktreesCommand(command: WorktreesCommand, cwd?: string): Promise<void> {
  switch (command.kind) {
    case "inventory":
      process.stdout.write(`${await renderInventory(cwd)}\n`)
      return
    case "new":
      await runNew(command, cwd)
      return
    case "fetch":
      await runFetch(command, cwd)
      return
    case "sync":
      await runSync(command, cwd)
      return
    case "push":
      await runPush(command, cwd)
      return
    case "pr":
      await runPr(command, cwd)
      return
    case "archive":
      await runArchive(command, cwd)
      return
    case "squash":
      await runSquash(command, cwd)
      return
    case "close":
      await runClose(command, cwd)
      return
    case "remove":
      await runRemove(command, cwd)
      return
    case "delete-branch":
      await runDeleteBranch(command, cwd)
      return
    case "recover":
      await runRecover(command, cwd)
      return
    case "cleanup-legacy":
      await runCleanupLegacy(command, cwd)
      return
  }
}

// ── inventory ────────────────────────────────────────────────────────────

/** The plain inventory listing: every registered checkout with its own local facts. */
export async function printInventory(): Promise<void> {
  process.stdout.write(`${await renderInventory()}\n`)
}

/** Renders the inventory (injectable cwd for tests); the printed form printInventory writes. */
export async function renderInventory(cwd?: string): Promise<string> {
  const dir = cwd ?? process.cwd()
  const inventory = await listWorktrees(dir)
  const out: string[] = []
  out.push(`worktrees of ${inventory.commonDir}:`)
  for (const entry of inventory.entries) {
    out.push(await describeEntry(entry))
    if (!entry.accessible || entry.bare) continue
    out.push(...(await describeLocalArtifacts(entry.path)))
  }
  return out.join("\n")
}

async function describeEntry(entry: WorktreeInventoryEntry): Promise<string> {
  const conditions: string[] = []
  if (entry.bare) conditions.push("bare (repository metadata, not a checkout)")
  if (entry.detached) conditions.push("detached HEAD")
  if (entry.locked) conditions.push(`locked${entry.locked.reason ? `: ${entry.locked.reason}` : ""}`)
  if (entry.prunable) conditions.push(`prunable${entry.prunable.reason ? `: ${entry.prunable.reason}` : ""}`)
  if (!entry.accessible) conditions.push("inaccessible (the registered path is missing — repair or `git worktree prune`)")
  const branch = entry.bare ? undefined : entry.detached ? "detached" : entry.branch
  const head = entry.head ? ` at ${entry.head.slice(0, 8)}` : ""
  const suffix = conditions.length > 0 ? ` — ${conditions.join("; ")}` : ""
  return `  ${entry.path}  ${branch ?? "(no branch)"}${head}${suffix}`
}

async function describeLocalArtifacts(checkout: string): Promise<string[]> {
  const lines: string[] = []
  const changes = await readCheckoutActiveChanges(checkout)
  if (changes.kind === "known") {
    if (changes.value.length === 0) {
      lines.push("    active changes: (none)")
    } else {
      lines.push("    active changes:")
      for (const change of changes.value) {
        const title = change.title ? ` — ${change.title}` : ""
        const tasks = change.tasks === undefined ? "" : change.tasks === "unknown" ? " tasks unknown" : ` tasks ${change.tasks.done}/${change.tasks.total}`
        const husk = change.hasMarkdown ? "" : " (husk: no readable artifacts)"
        lines.push(`      ${change.changeId}${title}${tasks}${husk}`)
      }
    }
  } else {
    lines.push(`    active changes: unknown (${changes.reason})`)
  }
  const archives = await readCheckoutArchives(checkout)
  if (archives.kind === "known" && archives.value.length > 0) lines.push(`    archived changes: ${archives.value.length} (browsable on demand)`)
  const specs = await readCheckoutCanonicalSpecs(checkout)
  if (specs.kind === "known" && specs.value.length > 0) lines.push(`    canonical specs: ${specs.value.length}`)
  return lines
}

// ── new (design D4: describe, suggest, review, create) ───────────────────

/**
 * The headless New worktree flow: the description proposes a conventional
 * branch (deterministic slug — the reviewed, editable naming model call is the
 * interactive launcher's), the destination follows the documented location
 * precedence, and creation runs through the same reviewed creation the Home
 * flow uses. Nothing is created until the reviewed inputs resolve.
 */
async function runNew(command: Extract<WorktreesCommand, { kind: "new" }>, cwd?: string): Promise<void> {
  const dir = cwd ?? process.cwd()
  const description = command.description.trim()
  if (!description) throw worktreesUsage("describe what you are building: convoy worktrees new <description> [--branch <name>] [--base <ref>] [--destination <path>]")
  const slug = description
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug) throw new Error("the description does not contain a usable branch slug — pass --branch <name> explicitly")
  const branch = command.branch ?? `feat/${slug}`
  const base = command.base ?? (await detectBaseRef(dir).catch(() => undefined))?.ref
  if (!base) throw new Error("no base could be detected — pass --base <local-branch> naming the branch to start from")
  const { resolveWorktreeDir } = await import("./worktree")
  const destination = command.destination ?? (await resolveWorktreeDir(branch, dir))
  // Reviewed inputs before any mutation: the operator sees exactly what will
  // be created, then the shared creation path runs it.
  process.stdout.write(`creating worktree:\n  branch:      ${branch}\n  base:        ${base}\n  destination: ${destination}\n`)
  await createReviewedWorktree({ displayName: description, branch, base, worktree: destination }, dir)
  process.stdout.write(`created ${destination} on ${branch} (from ${base}) — it appears in the Git inventory like any other checkout\n`)
}

/** The shared reviewed creation: intent journal → `git worktree add` → acknowledge → release. */
async function createReviewedWorktree(
  draft: { displayName: string; branch: string; base: string; worktree: string },
  dir: string,
): Promise<void> {
  const { execFile } = await import("./git")
  const { createOperation, recordStepIntent, acknowledgeStep, resolveOperation, ensureOperationsRoot } = await import("./operation-journal")
  const commonDir = await repoCommonDir(dir)
  // Recovery before fresh creation (task 3.5): a crash midway through an
  // earlier creation of this branch/worktree leaves a journal. Reconcile it
  // against reality first — a verified creation is reused (no duplicate), a
  // not-yet-created one is released so this fresh creation can proceed cleanly,
  // and unexplained state stops for inspection instead of re-creating.
  await reconcilePendingCreateOperations(commonDir, draft, dir)
  let operationId: string | undefined
  if (commonDir) {
    await ensureOperationsRoot(commonDir).catch(() => {})
    const created = await createOperation(commonDir, {
      kind: "worktree-create",
      intent: { displayName: draft.displayName, branch: draft.branch, base: draft.base, worktree: draft.worktree },
      steps: ["create"],
    })
    if (created.ok) {
      operationId = created.operation.operationId
      await recordStepIntent(commonDir, operationId, "create", { branch: draft.branch, worktree: draft.worktree, base: draft.base }).catch(() => {})
    }
  }
  const { findWorktreeDirForBranch } = await import("./git")
  const existing = await findWorktreeDirForBranch(draft.branch, dir).catch(() => undefined)
  if (!existing) {
    // Re-verify destination occupancy immediately before `git worktree add`
    // (capability home-launcher, task 10.2): a path taken between review and
    // creation is routed back to destination review instead of handing the
    // occupied path to Git and failing inside it.
    const destinationOccupied = await stat(draft.worktree).catch(() => undefined)
    if (destinationOccupied) {
      throw new Error(
        `the destination ${draft.worktree} is already occupied by another checkout — choose a different destination and review it again${operationId ? `\nThe creation intent is retained — inspect or cancel it with \`convoy worktrees recover --operation ${operationId}\`.` : ""}`,
      )
    }
    const added = await execFile("git", ["worktree", "add", "-b", draft.branch, draft.worktree, draft.base], { cwd: dir, allowFailure: true })
    if (added.exitCode !== 0) {
      throw new Error(
        `creating the worktree failed: ${(added.stderr || added.stdout).trim()}${operationId ? `\nThe creation intent is retained — inspect or cancel it with \`convoy worktrees recover --operation ${operationId}\`.` : ""}`,
      )
    }
  }
  if (commonDir && operationId) {
    await acknowledgeStep(commonDir, operationId, "create", { worktree: existing ?? draft.worktree }).catch(() => {})
    await resolveOperation({ commonDir, operationId, gitCwd: dir, outcome: "resolved" }).catch(() => {})
  }
}

/**
 * Reconciles a pending worktree-creation for this branch/worktree before a
 * fresh creation (task 3.5, design D9): a verified creation (the destination is
 * a registered checkout on the reviewed branch) is acknowledged and the journal
 * released so the call reuses it instead of duplicating; a not-yet-created one
 * is released so the fresh creation proceeds cleanly; unexplained reality
 * blocks with recovery guidance rather than re-creating blindly.
 */
async function reconcilePendingCreateOperations(
  commonDir: string | undefined,
  draft: { branch: string; worktree: string },
  dir: string,
): Promise<void> {
  if (!commonDir) return
  const { listPendingOperations, readOperation } = await import("./operation-journal")
  const { recoverOperation } = await import("./operation-recovery")
  const { reconcileStepReality } = await import("./operation-reconcile")
  const pending = await listPendingOperations(commonDir)
  for (const operationId of pending) {
    const read = await readOperation(commonDir, operationId)
    if (read.status !== "found" || read.value.kind !== "worktree-create") continue
    const intent = read.value.intent as { branch?: unknown; worktree?: unknown } | undefined
    if (intent?.branch !== draft.branch || (typeof intent.worktree === "string" && resolve(intent.worktree) !== resolve(draft.worktree))) continue
    const probe = (step: unknown, operation: unknown) => reconcileStepReality(step as never, operation as never, dir)
    const outcome = await recoverOperation({ commonDir, operationId, gitCwd: dir, probe, consent: "continue" })
    if (outcome.status === "blocked") {
      throw new Error(`a pending worktree creation (${operationId}) could not be reconciled: ${outcome.reason} — inspect it with \`convoy worktrees recover --operation ${operationId}\``)
    }
    if (outcome.status === "needs-work") {
      // The creation has not happened yet: release this stale intent so the
      // fresh creation below can proceed without a duplicate pending journal.
      await recoverOperation({ commonDir, operationId, gitCwd: dir, probe, consent: "cancel" }).catch(() => {})
    }
    // "reconciled" (verified creation) or "cancelled": the journal is released;
    // a verified creation is reused through the branch/worktree lookup below.
  }
}

// ── pr (tasks 5.4–5.6) ───────────────────────────────────────────────────

async function runPr(command: Extract<WorktreesCommand, { kind: "pr" }>, cwd?: string): Promise<void> {
  const { runPrOperation } = await import("./pr-operations")
  const outcome = await runPrOperation(
    {
      checkout: command.worktree,
      ...(command.base ? { base: command.base } : {}),
      ...(command.repo ? { repo: command.repo } : {}),
      ...(command.headRepo ? { headRepo: command.headRepo } : {}),
      ...(command.title !== undefined ? { title: command.title } : {}),
      ...(command.body !== undefined ? { body: command.body } : {}),
      push: command.push,
    },
    cwd,
  )
  if (!outcome.ok) {
    process.stderr.write(`blocked: ${outcome.reason}\n`)
    process.exitCode = 1
    return
  }
  if (outcome.pushed) process.stdout.write(`pushed ${outcome.pushed} (normal non-force update)\n`)
  if (outcome.pr) {
    process.stdout.write(outcome.reused ? `existing open PR #${outcome.pr.number}: ${outcome.pr.url} — reused, not duplicated\n` : `created PR: ${outcome.pr.url}\n`)
  } else {
    process.stdout.write("no PR was created\n")
  }
}

// ── fetch ────────────────────────────────────────────────────────────────

async function runFetch(command: Extract<WorktreesCommand, { kind: "fetch" }>, cwd?: string): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const review = await reviewOperation({ action: "fetch", checkout: command.worktree, commonDir })
  if (!review.ok) return reportBlocked(review.blockers)
  const result = await executeReviewed({
    action: "fetch",
    checkout: command.worktree,
    commonDir,
    review: review.review,
    effect: async (target) => {
      // Fetch updates the selected remote's refs; it never merges into a checkout.
      const result = await execFile("git", ["fetch", "--", command.remote], { cwd: target.checkoutPath, allowFailure: true })
      if (result.exitCode !== 0) throw new Error(`git fetch ${command.remote} failed: ${(result.stderr || result.stdout).trim()}`)
      return { fetched: command.remote }
    },
  })
  if (!result.ok) return reportBlocked(result.blockers, result.reason)
  process.stdout.write(`fetched ${command.remote} (remote-tracking refs updated; no checkout was merged into)\n`)
}

// ── sync ─────────────────────────────────────────────────────────────────

async function runSync(command: Extract<WorktreesCommand, { kind: "sync" }>, cwd?: string): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const review = await reviewOperation({ action: "sync", checkout: command.worktree, base: command.base, commonDir })
  if (!review.ok) return reportBlocked(review.blockers)
  const result = await executeReviewed({
    action: "sync",
    checkout: command.worktree,
    base: command.base,
    commonDir,
    review: review.review,
    effect: async (target) => {
      // Fresh containment fact at execution time — the reviewed base may have
      // moved since review, and only the current relation decides no-op vs merge.
      const divergence = await observeBaseDivergence(target.checkoutPath, command.base)
      if (divergence.kind === "known" && divergence.value.baseContainedInSource) return { merged: false }
      // Merge the reviewed base revision into the attached source. Conflicts
      // stay in ordinary Git conflict state for the operator to resolve.
      const merge = await execFile("git", ["merge", "--no-edit", "--", command.base], { cwd: target.checkoutPath, allowFailure: true })
      if (merge.exitCode !== 0) {
        throw new Error(
          `sync merge did not complete${/CONFLICT|conflict/i.test(merge.stdout + merge.stderr) ? " — the conflict state is left in place: resolve it (or \`git merge --abort\`) and re-run sync" : `: ${(merge.stderr || merge.stdout).trim()}`}`,
        )
      }
      return { merged: true }
    },
  })
  if (!result.ok) return reportBlocked(result.blockers, result.reason)
  process.stdout.write(result.value.merged ? `synced ${command.base} into the selected checkout\n` : `${command.base} is already contained in the source — no sync needed\n`)
}

// ── push ─────────────────────────────────────────────────────────────────

async function runPush(command: Extract<WorktreesCommand, { kind: "push" }>, cwd?: string): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const branch = await currentBranch(command.worktree)
  if (!branch) throw new Error(`checkout ${command.worktree} has a detached HEAD; push needs an attached branch to name a source ref`)

  let remote = command.remote
  let refspec = command.refspec
  if (refspec) assertNonForceRefspec(refspec)
  if (!remote || !refspec) {
    // The configured upstream is the disclosed default destination; without
    // one, the operator must select the destination explicitly — never guessed.
    const upstream = await branchUpstream(branch, command.worktree)
    if (upstream) {
      const separator = upstream.indexOf("/")
      remote ??= upstream.slice(0, separator)
      refspec ??= `${branch}:${upstream.slice(separator + 1)}`
    } else if (!remote || !refspec) {
      throw new Error(
        `branch ${branch} has no configured upstream — pass an explicit destination: --remote <name> --ref <local>:<remote> (e.g. --remote origin --ref ${branch}:${branch})`,
      )
    }
  }
  if (!remote || !refspec) throw new Error("push needs both a remote and a refspec")

  const outcome = await pushCommittedRevision({ checkout: command.worktree, commonDir, remote, refspec })
  if (!outcome.ok) return reportBlocked(outcome.blockers, outcome.reason)
  process.stdout.write(`pushed ${refspec} to ${remote} (normal non-force update; uncommitted local files were excluded)\n`)
}

// ── archive ──────────────────────────────────────────────────────────────

/**
 * Whether the installed OpenSpec CLI supports archiving a change whose tasks
 * are not all complete (task 6.1, design D7). Convoy must not invent an
 * incomplete-task override the installed CLI does not provide, so it queries
 * `openspec archive --help` and recognizes the documented override flags; a CLI
 * without one exposes no override and the ordinary requirement stands.
 */
async function archiveIncompleteOverrideSupported(): Promise<boolean> {
  try {
    const help = await execFile("openspec", ["archive", "--help"], { cwd: process.cwd(), allowFailure: true })
    if (help.exitCode !== 0) return false
    const text = help.stdout + help.stderr
    return /--allow-incomplete|--incomplete|-[-a-z]*incomplete/i.test(text)
  } catch {
    return false
  }
}

/**
 * The selected inputs must exist in this checkout with known complete tasks
 * before any mutation (task 6.1): unknown or incomplete tasks block the
 * ordinary archive, and unselected/inherited changes are never included. An
 * incomplete-task override is exposed only when the operator explicitly
 * requests it AND the installed OpenSpec CLI supports it (`--allow-incomplete`);
 * otherwise incomplete tasks still block, and a requested-but-unsupported
 * override is refused rather than guessed around.
 */
async function validateArchiveInputs(checkout: string, changes: string[], options: { allowIncomplete?: boolean } = {}): Promise<void> {
  const local = await readCheckoutActiveChanges(checkout)
  if (local.kind !== "known") throw new Error(`the selected checkout's active changes could not be read: ${local.reason}`)
  const byId = new Map(local.value.map((change) => [change.changeId, change]))
  for (const id of changes) {
    const change = byId.get(id)
    if (!change) throw new Error(`change "${id}" is not an active change of ${checkout} — select changes that exist in this checkout`)
    if (change.tasks === undefined || change.tasks === "unknown") {
      if (options.allowIncomplete) throw new Error(`change "${id}" has unknown tasks; an incomplete-task override does not apply to unknown task counts`)
      throw new Error(`change "${id}" has no tasks file; its completeness is unknown and the ordinary archive refuses unknown tasks`)
    }
    if (change.tasks.done < change.tasks.total) {
      if (options.allowIncomplete) {
        if (!(await archiveIncompleteOverrideSupported())) {
          throw new Error(`change "${id}" has incomplete tasks and the installed OpenSpec does not support archiving incomplete changes — complete the tasks or archive without the override`)
        }
        continue
      }
      throw new Error(`change "${id}" has ${change.tasks.done}/${change.tasks.total} tasks complete — incomplete tasks block the ordinary archive`)
    }
  }
}

/**
 * The archive effect body (tasks 6.2–6.4): OpenSpec archives each selected
 * change in order, the actual output is inspected, and only verified output is
 * committed. Every step is journaled before its effect and acknowledged only
 * after verification (design D9), so a crash between `openspec archive` and
 * its commit is recoverable through `convoy worktrees recover` — the journal
 * lives outside the checkout and reconciles against reality.
 */
async function archiveSelectedChanges(
  checkout: string,
  changes: string[],
  commonDir: string,
  /** Releases the alternate screen around the inherited-terminal archive commit (interactive close). */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<{ archived: string[] }> {
  const { createOperation, recordStepIntent, acknowledgeStep, resolveOperation } = await import("./operation-journal")
  // Intent before effect: one journaled step per selected change plus the
  // commit. A journal that cannot be persisted blocks the mutation — an
  // effect nobody recorded the inputs for is one recovery cannot verify.
  const stepIds = [...changes.map((id) => `archive:${id}`), "commit"]
  const created = await createOperation(commonDir, {
    kind: "archive",
    intent: { checkout, changes },
    steps: stepIds,
  })
  if (!created.ok) {
    throw new Error(`the archive journal could not be persisted — no mutation was made: ${created.reason}`)
  }
  const operationId = created.operation.operationId
  for (const id of changes) {
    await recordStepIntent(commonDir, operationId, `archive:${id}`, { changeId: id, checkout }).catch(() => {})
  }
  await recordStepIntent(commonDir, operationId, "commit", { checkout, changes }).catch(() => {})

  const before = await statusPorcelain(checkout)
  const archived: string[] = []
  for (const id of changes) {
    const archive = await execFile("openspec", ["archive", id, "--yes"], { cwd: checkout, allowFailure: true })
    if (archive.exitCode !== 0) {
      throw new Error(`openspec archive ${id} failed: ${(archive.stderr || archive.stdout).trim()}`)
    }
    // Verify the effect in reality before acknowledging it: the change must
    // have left this checkout's active set.
    const active = await readCheckoutActiveChanges(checkout)
    if (active.kind === "known" && active.value.some((change) => change.changeId === id)) {
      throw new Error(`openspec reported success but ${id} did not leave the active set — nothing was committed; inspect the archive output`)
    }
    archived.push(id)
    const ack = await acknowledgeStep(commonDir, operationId, `archive:${id}`, { changeId: id })
    if (!ack.ok) {
      throw new Error(`the archive of ${id} succeeded but its journal acknowledgement failed: ${ack.reason} — inspect with \`convoy worktrees recover --operation ${operationId}\``)
    }
  }
  // Inspect the actual output: only OpenSpec paths may have changed.
  const after = await statusPorcelain(checkout)
  const changed = changedPaths(before, after)
  const outside = changed.filter((path) => !path.startsWith(`${openspecDirName}/`))
  if (outside.length > 0) {
    throw new Error(`archive touched paths outside ${openspecDirName}/ (${outside.join(", ")}) — nothing was committed; inspect and resolve before retrying`)
  }
  // Semantic proof (task 6.2): the composed output must validate with the real
  // OpenSpec CLI, not merely sit under `openspec/` by position. Gated honestly —
  // this guards a genuine archive output (paths actually changed) in a checkout
  // that speaks canonical OpenSpec (has its own `openspec/specs/`). A checkout
  // without canonical specs, or an environment where the CLI cannot run, is not
  // an OpenSpec consumer: there, refraining from validation must not invent a
  // failure, and a failed spawn is not evidence the output is invalid.
  if (changed.length > 0 && (await checkoutHasCanonicalSpecs(checkout))) {
    let validate
    try {
      validate = await execFile("openspec", ["validate", "--all"], { cwd: checkout, allowFailure: true })
    } catch {
      validate = undefined
    }
    if (validate && validate.exitCode !== 0) {
      throw new Error(`the archived output failed OpenSpec validation: ${(validate.stderr || validate.stdout || "validation reported errors").trim()}`)
    }
  }
  // Commit only the verified archive output, under the operator's identity.
  await execFile("git", ["add", "--", `${openspecDirName}/`], { cwd: checkout })
  // `commitAsUser` inherits the terminal (signing, hooks), so an interactive
  // close suspends its alternate screen around it: otherwise git's summary
  // paints over the live interface and the diff renderer never repaints.
  const commit = () => commitAsUser(`chore: archive ${archived.join(", ")}`, checkout)
  await (withTerminal ? withTerminal(commit) : commit())
  const commitAck = await acknowledgeStep(commonDir, operationId, "commit", { changes: archived })
  if (!commitAck.ok) {
    throw new Error(`the archive commit succeeded but its journal acknowledgement failed: ${commitAck.reason} — inspect with \`convoy worktrees recover --operation ${operationId}\``)
  }
  await resolveOperation({ commonDir, operationId, gitCwd: checkout, outcome: "resolved" }).catch(() => {})
  return { archived }
}

/**
 * Recovery before fresh-archive preflight (design D9, task 6.4): an
 * interrupted archive of this checkout is reconciled against reality before a
 * new archive mutates anything. Verified archive steps are acknowledged; when
 * only the commit remains and the output is uncommitted but confined to
 * OpenSpec paths, exactly that output is committed and the operation resolved.
 * Anything unexplained blocks with recovery guidance instead of guessing.
 */
async function reconcilePendingArchiveOperations(
  commonDir: string,
  checkout: string,
  /** Releases the alternate screen around the reconcile commit when one is needed (interactive close). */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const pending = await listPendingOperations(commonDir)
  for (const operationId of pending) {
    const read = await readOperation(commonDir, operationId)
    if (read.status !== "found" || read.value.kind !== "archive") continue
    const intent = read.value.intent as { checkout?: string } | undefined
    if (typeof intent?.checkout !== "string" || resolve(intent.checkout) !== resolve(checkout)) continue
    const probe: ReconcileProbe = (step, operation) => reconcileStepReality(step, operation, checkout)
    const outcome = await recoverOperation({ commonDir, operationId, gitCwd: checkout, probe, consent: "continue" })
    if (outcome.status === "blocked") {
      throw new Error(`a pending archive operation (${operationId}) could not be reconciled: ${outcome.reason} — inspect it with \`convoy worktrees recover --operation ${operationId}\``)
    }
    if (outcome.status === "needs-work") {
      if (outcome.remaining.length === 1 && outcome.remaining[0] === "commit") {
        await completeInterruptedArchiveCommit(commonDir, operationId, checkout, withTerminal)
        continue
      }
      throw new Error(`a pending archive operation (${operationId}) still has unresolved steps (${outcome.remaining.join(", ")}) — inspect it with \`convoy worktrees recover --operation ${operationId}\` before archiving here`)
    }
    // reconciled or cancelled: the journal is released; nothing to carry over.
  }
}

/**
 * Completes the interrupted commit of an archive operation: the working tree
 * must hold only OpenSpec paths, which are committed under the operator's
 * identity; a clean tree means the commit already happened and is only
 * acknowledged. The journal is then resolved and released.
 */
async function completeInterruptedArchiveCommit(
  commonDir: string,
  operationId: string,
  checkout: string,
  /** Releases the alternate screen around the inherited-terminal reconcile commit (interactive close). */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const { acknowledgeStep, resolveOperation, readOperation } = await import("./operation-journal")
  const read = await readOperation(commonDir, operationId)
  const intent = read.status === "found" ? (read.value.intent as { changes?: unknown } | undefined) : undefined
  const changes = Array.isArray(intent?.changes) ? intent!.changes.filter((entry): entry is string => typeof entry === "string") : []
  const status = await statusPorcelain(checkout)
  const lines = status.split("\n").filter((line) => line.trim() !== "")
  const outside = lines.map((line) => line.slice(3).trim()).filter((path) => path !== "" && !path.startsWith(`${openspecDirName}/`))
  if (outside.length > 0) {
    throw new Error(`the interrupted archive left changes outside ${openspecDirName}/ (${outside.join(", ")}) — inspect before committing; see \`convoy worktrees recover --operation ${operationId}\``)
  }
  if (lines.length > 0) {
    await execFile("git", ["add", "--", `${openspecDirName}/`], { cwd: checkout })
    const commit = () => commitAsUser(`chore: archive ${changes.join(", ")}`, checkout)
    await (withTerminal ? withTerminal(commit) : commit())
  }
  const ack = await acknowledgeStep(commonDir, operationId, "commit", { completed: true, ...(lines.length === 0 ? { alreadyCommitted: true } : {}) })
  if (!ack.ok) {
    throw new Error(`the interrupted archive commit could not be acknowledged: ${ack.reason} — inspect with \`convoy worktrees recover --operation ${operationId}\``)
  }
  await resolveOperation({ commonDir, operationId, gitCwd: checkout, outcome: "resolved" }).catch(() => {})
}

async function runArchive(command: Extract<WorktreesCommand, { kind: "archive" }>, cwd?: string, route?: TuiRoute): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  // Recovery before fresh preflight (design D9): an interrupted archive of
  // this checkout is reconciled against reality before anything new runs —
  // including before the task/cleanliness validation that an already-archived
  // change would otherwise fail.
  await reconcilePendingArchiveOperations(commonDir, command.worktree)
  const review = await reviewOperation({ action: "archive", checkout: command.worktree, commonDir })
  if (!review.ok) return reportBlocked(review.blockers)
  await validateArchiveInputs(command.worktree, command.changes, { allowIncomplete: command.allowIncomplete })

  const result = await executeReviewed({
    action: "archive",
    checkout: command.worktree,
    commonDir,
    review: review.review,
    effect: async (target) => archiveSelectedChanges(target.checkoutPath, command.changes, commonDir),
  })
  if (!result.ok) return reportBlocked(result.blockers, result.reason)
  const summary = `archived and committed: ${result.value.archived.join(", ")}`
  if (route) {
    const { showNoticeTui } = await import("./notice-tui")
    await showNoticeTui(route, { title: "archive complete", message: summary })
  } else {
    process.stdout.write(`${summary}\n`)
  }
}

/**
 * The Home archive action: an explicit change selection archived through the
 * same guarded operation, with the outcome shown in a TUI notice instead of
 * raw stdout over the alternate screen.
 */
export async function runWorktreeArchive(
  input: { worktree: string; changes: string[]; allowIncomplete?: boolean; route?: TuiRoute },
  cwd?: string,
): Promise<void> {
  await runArchive(
    { kind: "archive", worktree: input.worktree, changes: input.changes, ...(input.allowIncomplete ? { allowIncomplete: true } : {}) },
    cwd,
    input.route,
  )
}

// ── squash ───────────────────────────────────────────────────────────────

async function runSquash(command: Extract<WorktreesCommand, { kind: "squash" }>, cwd?: string): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const review = await reviewOperation({ action: "squash", checkout: command.worktree, base: command.base, commonDir })
  if (!review.ok) return reportBlocked(review.blockers)
  const result = await executeReviewed({
    action: "squash",
    checkout: command.worktree,
    base: command.base,
    commonDir,
    review: review.review,
    effect: async (target) =>
      squashToBase({ checkout: target.checkoutPath, base: command.base, commonDir, message: command.message }),
  })
  if (!result.ok) return reportBlocked(result.blockers, result.reason)
  if (!result.value.ok) {
    process.stderr.write(`blocked: ${result.value.reason}\n`)
    process.exitCode = 1
    return
  }
  if ("noDifference" in result.value) {
    process.stdout.write("the source and the base hold identical trees — no content difference, no commit created\n")
    return
  }
  process.stdout.write(`landed ${result.value.landedSha.slice(0, 8)} on ${result.value.base} (one commit; the source branch's history was not rewritten)\n`)
}

// ── close ────────────────────────────────────────────────────────────────

/**
 * Close composes the same reviewed operations — sync as needed, archive of the
 * explicitly selected local changes, then the whole-branch squash — with zero
 * selected changes supported. Selecting changes controls archive inputs, never
 * squash scope; push, worktree removal, and branch deletion remain separate
 * actions and are never performed here.
 */
export type WorktreeCloseInput = {
  checkout: string
  base: string
  changes: string[]
  message?: string
  /** Keep the landing local even when a linked open PR offers the hosted path (design D5). */
  localLanding?: boolean
  /** The home-session route, when close was opened from a TUI menu. */
  route?: TuiRoute
}

/** The shared close composite (design D8): one implementation, every entry point. */
export async function runWorktreeClose(input: WorktreeCloseInput, cwd?: string): Promise<void> {
  const command: Extract<WorktreesCommand, { kind: "close" }> = {
    kind: "close",
    worktree: input.checkout,
    base: input.base,
    changes: input.changes,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.localLanding ? { localLanding: true } : {}),
  }
  await runClose(command, cwd, input.route)
}

type CloseProgress = {
  onEvent?: (event: CloseEvent) => void
  /** The interactive message gate; absent in headless mode. */
  resolveMessage?: (proposal: CloseMessageProposal, notice?: string) => Promise<string | undefined>
  /**
   * The interactive landing gate offered when a linked open PR enables the
   * hosted path (change `close-lands-via-github-pr`, design D5): the reviewed
   * message plus the hosted/local landing choice in one gate.
   */
  resolveLanding?: (proposal: CloseMessageProposal, notice?: string) => Promise<CloseLandingDecision>
  /**
   * Releases the alternate screen around mutations whose git output is
   * inherited (the archive commits, the squash candidate's `commitAsUser`, and
   * the remote branch push): the TUI must suspend first or git's summary paints
   * over the live interface, and a diff-based renderer never repaints the
   * stomped cells.
   */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>
}

type CloseOutcome = {
  steps: string[]
  cancelled?: boolean
  pullRequest?: { number: number; title?: string; url: string }
  /** Observed hosted-landing facts; present only when GitHub's merge was observed. */
  hostedMerge?: HostedMergeFacts
}

/**
 * The close effect driver (capability feature-close delta): sync as needed,
 * archive the explicitly selected changes, then land the whole branch with a
 * composed conventional message. Progress travels through typed events so the
 * interactive checklist and the headless summary narrate the same facts; the
 * message context is captured before archive moves the proposals. Exported
 * for tests: the landing gates (hosted/local/cancel) are driven directly.
 */
export async function driveClose(
  command: Extract<WorktreesCommand, { kind: "close" }>,
  commonDir: string,
  review: OperationInspection,
  progress: CloseProgress = {},
): Promise<ExecutionOutcome<CloseOutcome>> {
  const emit = (event: CloseEvent) => progress.onEvent?.(event)
  return executeReviewed({
    action: "close",
    checkout: command.worktree,
    base: command.base,
    commonDir,
    review,
    effect: async (target) => {
      const steps: string[] = []
      const branch = target.branch ?? ""
      emit({ type: "preflight", summary: `${branch} → ${command.base}` })
      // Pending hosted landing first (change `close-lands-via-github-pr`,
      // design D9): a previously interrupted remote transaction is reconciled
      // by receipt BEFORE any close mutation — before the sync merge, before
      // the archive — so neither step can build on a base or checkout whose
      // state a pending effect still owns. Verified effects are recognized by
      // receipt; undecided steps require explicit recovery continuation
      // (`convoy worktrees recover --operation <id> --continue|--cancel`)
      // before this close may mutate anything.
      await reconcilePendingHostedCloses(commonDir, target.checkoutPath, branch, target.checkoutPath)
      // The squash message's context is captured before archive relocates the
      // proposals (design D7): commit subjects, diff shape, proposal excerpts,
      // and the capabilities the selected changes touch.
      const context = await captureCloseMessageContext(target.checkoutPath, command.changes, command.base)

      // 1. Sync as needed: merge the reviewed base when it is not contained.
      emit({ type: "step-started", step: "sync" })
      const divergence = await observeBaseDivergence(target.checkoutPath, command.base)
      if (divergence.kind !== "known") throw new Error(`the base comparison could not be read: ${divergence.reason}`)
      if (!divergence.value.baseContainedInSource) {
        const merge = await execFile("git", ["merge", "--no-edit", "--", command.base], { cwd: target.checkoutPath, allowFailure: true })
        if (merge.exitCode !== 0) {
          throw new Error(
            `sync merge did not complete${/CONFLICT|conflict/i.test(merge.stdout + merge.stderr) ? " — the conflict state is left in place: resolve it (or \`git merge --abort\`) and re-run close" : `: ${(merge.stderr || merge.stdout).trim()}`}`,
          )
        }
        steps.push(`synced ${command.base}`)
        emit({ type: "step-completed", step: "sync", detail: `merged ${command.base}` })
      } else {
        steps.push(`${command.base} already contained — no sync needed`)
        emit({ type: "step-skipped", step: "sync", reason: `${command.base} is already contained in the source` })
      }

      // 2. Archive the explicitly selected local changes (zero supported).
      if (command.changes.length > 0) {
        emit({ type: "step-started", step: "archive" })
        await reconcilePendingArchiveOperations(commonDir, target.checkoutPath, progress.withTerminal)
        const archived = await archiveSelectedChanges(target.checkoutPath, command.changes, commonDir, progress.withTerminal)
        steps.push(`archived ${archived.archived.join(", ")}`)
        emit({ type: "step-completed", step: "archive", detail: archived.archived.join(", ") })
      } else {
        emit({ type: "step-skipped", step: "archive", reason: "no changes selected — zero-archive close" })
      }

      // 3. Land the whole branch result on the base, through message review.
      emit({ type: "step-started", step: "squash-merge" })
      emit({ type: "squash-phase", phase: "composing-message" })
      const pr = await probeClosePullRequest(branch, target.checkoutPath)
      // Headless composition is deterministic only (design D6: no model wait
      // without explicit acceptance); the interactive path may use the bounded
      // writer and always reviews its output.
      const composed = await composeCloseMessage({
        checkout: target.checkoutPath,
        branch,
        changes: command.changes,
        context,
        pullRequest: pr.status === "found" ? pr : undefined,
        model: progress.resolveMessage !== undefined,
      })
      emit({ type: "squash-phase", phase: "awaiting-message-review" })
      let message = command.message ?? composed.message
      // Landing routing (change `close-lands-via-github-pr`, design D1): a
      // linked open PR with usable evidence selects the hosted path; no PR,
      // unavailable evidence, an ambiguous match, `--local-landing`, or an
      // operator decline select the unchanged local path with disclosure.
      let hosted = pr.status === "found" && !command.localLanding
      const proposal = { message: composed.message, source: composed.source, ...(composed.error ? { error: composed.error } : {}) }
      if (command.message === undefined && (progress.resolveMessage || progress.resolveLanding)) {
        const notice =
          pr.status === "found"
            ? command.localLanding
              ? `open pull request detected: #${pr.number}${pr.title ? ` ${pr.title}` : ""} — ${pr.url}\n--local-landing keeps the landing local; the PR number rides the reviewed subject as a reference, not a claim that the PR merged.`
              : `open pull request detected: #${pr.number}${pr.title ? ` ${pr.title}` : ""} — ${pr.url}\nHosted landing plan: push ${branch} to its remote, ask GitHub to squash-merge PR #${pr.number} with the reviewed message, then fast-forward ${command.base} to GitHub's squash commit. Choose "Land locally instead" to keep every step local.`
            : pr.status === "ambiguous"
              ? `${pr.count} open pull requests match ${branch} — none is treated as the linked PR, so the landing stays local.`
              : pr.status === "unavailable"
                ? `pull-request evidence is unavailable: ${pr.reason} — close proceeds without asserting any PR state.`
                : undefined
        if (pr.status === "found" && progress.resolveLanding && !command.localLanding) {
          const decision = await progress.resolveLanding(proposal, notice)
          if (decision.kind === "cancel") {
            // Cancellation preserves the completed preparation; nothing lands.
            emit({ type: "step-skipped", step: "squash-merge", reason: "message review cancelled — nothing landed" })
            return { steps, cancelled: true }
          }
          message = decision.message
          hosted = decision.kind === "hosted"
        } else if (progress.resolveMessage) {
          const accepted = await progress.resolveMessage(proposal, notice)
          if (accepted === undefined) {
            emit({ type: "step-skipped", step: "squash-merge", reason: "message review cancelled — nothing landed" })
            return { steps, cancelled: true }
          }
          message = accepted
        }
      }

      // Equal trees land nothing on either path: a hosted merge of an empty
      // difference would be refused by GitHub, and the local path reports it
      // honestly (capability worktree-operations).
      const sourceTip = await resolveCommit("HEAD", target.checkoutPath)
      const baseSha = await resolveCommit(command.base, target.checkoutPath)
      if (sourceTip && baseSha) {
        const equality = await observeTreeEquality(sourceTip, baseSha, target.checkoutPath)
        if (equality.kind === "known" && equality.value.equalTrees) {
          steps.push("no content difference — nothing landed")
          emit({ type: "step-skipped", step: "squash-merge", reason: "the source and the base hold identical trees" })
          return withPullRequestOutcome({ steps }, pr)
        }
      }

      if (hosted && pr.status === "found") {
        // The hosted landing (change `close-lands-via-github-pr`): publish the
        // branch, request GitHub's squash-merge with the reviewed message, then
        // fast-forward the local base. Interrupted steps were already
        // reconciled by receipt above, before sync/archive.
        const landed = await (progress.withTerminal
          ? progress.withTerminal(() =>
              landViaGitHub({
                checkout: target.checkoutPath,
                branch,
                base: command.base,
                commonDir,
                prNumber: pr.number,
                message,
                onEvent: emit,
              }),
            )
          : landViaGitHub({
              checkout: target.checkoutPath,
              branch,
              base: command.base,
              commonDir,
              prNumber: pr.number,
              message,
              onEvent: emit,
            }))
        if (!landed.ok) throw new Error(landed.reason)
        steps.push(...landed.narration)
        emit({ type: "step-completed", step: "squash-merge", detail: `PR #${pr.number} merged${landed.facts.mergeSha ? ` as ${landed.facts.mergeSha.slice(0, 8)}` : ""}` })
        return { steps, pullRequest: { number: pr.number, ...(pr.title !== undefined ? { title: pr.title } : {}), url: pr.url }, hostedMerge: landed.facts }
      }

      emit({ type: "squash-phase", phase: "creating-commit" })
      // The candidate commit inherits the terminal (signing, hooks), so an
      // interactive close suspends its TUI across the whole guarded squash;
      // headless mode runs with no renderer to suspend.
      const squash = await (progress.withTerminal
        ? progress.withTerminal(() => squashToBase({ checkout: target.checkoutPath, base: command.base, commonDir, message }))
        : squashToBase({ checkout: target.checkoutPath, base: command.base, commonDir, message }))
      if (!squash.ok) throw new Error(squash.reason)
      if ("noDifference" in squash) {
        steps.push("no content difference — nothing landed")
        emit({ type: "step-skipped", step: "squash-merge", reason: "the source and the base hold identical trees" })
      } else {
        steps.push(`landed ${squash.landedSha.slice(0, 8)} on ${command.base}`)
        emit({ type: "step-completed", step: "squash-merge", detail: `${squash.landedSha.slice(0, 8)} on ${command.base}` })
      }
      return withPullRequestOutcome({ steps }, pr)
    },
  })
}

/** The outcome's PR disclosure, present only for a found open PR. */
function withPullRequestOutcome(outcome: { steps: string[] }, pr: ClosePullRequestProbe): CloseOutcome {
  return { ...outcome, ...(pr.status === "found" ? { pullRequest: { number: pr.number, ...(pr.title !== undefined ? { title: pr.title } : {}), url: pr.url } } : {}) }
}

/**
 * The shared-session close handoff (capability feature-close): the close
 * screen's progress mode consumes every key (`stopPropagation`), so it must
 * release its keyboard handling before the completion notice mounts — otherwise
 * the notice never receives `q`/Escape/Enter/Ctrl+C and stays frozen. `destroy`
 * is idempotent and leaves a shared renderer alive; `openScene` then closes the
 * close tree as the notice mounts. Exported for the lifecycle regression test.
 */
export async function showCloseOutcome(route: TuiRoute, tui: CloseTui, outcome: CloseOutcome): Promise<void> {
  tui.destroy()
  const { showNoticeTui } = await import("./notice-tui")
  await showNoticeTui(route, { title: outcome.cancelled ? "close cancelled" : "close complete", message: closeSummaryLines(outcome).join("\n") })
}

async function runClose(command: Extract<WorktreesCommand, { kind: "close" }>, cwd?: string, route?: TuiRoute): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const review = await reviewOperation({ action: "close", checkout: command.worktree, base: command.base, commonDir })
  if (!review.ok) return reportBlocked(review.blockers)
  if (command.changes.length > 0) await validateArchiveInputs(command.worktree, command.changes)

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && command.message === undefined
  if (interactive) {
    const { openCloseTui } = await import("./close-tui")
    const tui = await openCloseTui(command.worktree, undefined, route)
    try {
      const result = await driveClose(command, commonDir, review.review, {
        onEvent: (event) => tui.onEvent(event),
        resolveMessage: (proposal, notice) => tui.confirmMessage(proposal, notice),
        resolveLanding: (proposal, notice) => tui.confirmMessageWithLanding(proposal, notice),
        withTerminal: (action) => tui.withTerminal(action),
      })
      if (!result.ok) {
        process.exitCode = 1
        await tui.showFailure(result.blockers.map((blocker) => blocker.reason).join("\n") || result.reason || "the reviewed target changed before execution")
        return
      }
      const summary = closeSummaryLines(result.value)
      if (route) {
        // Release the close screen's input before the notice mounts (the
        // frozen-notice fix); the finally below stays as a safety net.
        await showCloseOutcome(route, tui, result.value)
      } else {
        process.stdout.write(`${summary.join("\n")}\n`)
      }
    } catch (error) {
      process.exitCode = 1
      // The failed checklist and remediation stay readable inside the TUI
      // until dismissed; the terminal state is restored afterwards.
      await tui.showFailure(error instanceof Error ? error.message : String(error))
    } finally {
      tui.destroy()
    }
    return
  }

  // The headless reviewed plan (change `close-lands-via-github-pr`, task 3.2):
  // when a linked open PR enables the hosted path and --local-landing did not
  // decline it, the remote steps are disclosed before any effect runs.
  if (!command.localLanding) {
    const branch = await currentBranch(command.worktree).catch(() => undefined)
    if (branch) {
      const pr = await probeClosePullRequest(branch, command.worktree)
      if (pr.status === "found") {
        process.stdout.write(`close plan: review → sync (as needed) → archive ${command.changes.length > 0 ? command.changes.join(", ") : "(no changes selected)"} → hosted landing via PR #${pr.number}: push ${branch} to its remote, GitHub squash-merge with the reviewed message, fast-forward ${command.base}\n`)
      }
    }
  }
  const result = await driveClose(command, commonDir, review.review)
  if (!result.ok) return reportBlocked(result.blockers, result.reason)
  const lines = closeSummaryLines(result.value)
  lines.push("push, worktree removal, and branch deletion remain separate actions (`convoy worktrees push|remove|delete-branch`).")
  process.stdout.write(`${lines.join("\n")}\n`)
}

/**
 * The shared close summary: the operation facts, the hosted merge when it was
 * observed (change `close-lands-via-github-pr`), and the PR reference
 * otherwise — never a merge claim without the observation.
 */
function closeSummaryLines(outcome: CloseOutcome): string[] {
  const lines = [outcome.cancelled ? "close cancelled:" : "close complete:"]
  for (const step of outcome.steps) lines.push(`  - ${step}`)
  if (outcome.hostedMerge) {
    const facts = outcome.hostedMerge
    lines.push(`PR #${facts.prNumber} was merged by GitHub${facts.mergeSha ? ` as ${facts.mergeSha.slice(0, 8)}` : ""}`)
    if (facts.mergeSha) {
      lines.push(facts.baseAdvanced ? `  the local ${facts.base} was fast-forwarded to GitHub's squash commit` : `  the local ${facts.base} already contained GitHub's squash commit`)
    }
  } else if (outcome.pullRequest) {
    lines.push(`open pull request on this branch: #${outcome.pullRequest.number}${outcome.pullRequest.title ? ` ${outcome.pullRequest.title}` : ""} — ${outcome.pullRequest.url}`)
    lines.push("  (a detected PR number is a reference, not a claim that GitHub merged it)")
  }
  return lines
}

/** The message context captured before archive relocates the proposals (design D7). */
type CloseMessageContext = {
  commits: string[]
  diffStat?: string
  proposalExcerpt?: string
  scopeCandidates: string[]
}

async function captureCloseMessageContext(checkout: string, changes: string[], base: string): Promise<CloseMessageContext> {
  const [log, diff] = await Promise.all([
    execFile("git", ["log", "--no-merges", "--format=%s", `${base}..HEAD`], { cwd: checkout, allowFailure: true }),
    execFile("git", ["diff", "--stat", `${base}...HEAD`], { cwd: checkout, allowFailure: true }),
  ])
  const commits = log.exitCode === 0 ? log.stdout.split("\n").map((line) => stripControlBytes(line).trim()).filter(Boolean) : []
  const context: CloseMessageContext = { commits, scopeCandidates: [] }
  if (diff.exitCode === 0 && diff.stdout.trim()) context.diffStat = diff.stdout
  for (const id of changes) {
    const changeDir = join(checkout, openspecDirName, "changes", id)
    if (context.proposalExcerpt === undefined) {
      try {
        context.proposalExcerpt = await readFile(join(changeDir, "proposal.md"), "utf8")
      } catch {
        // A missing proposal costs the message its rationale, not the close.
      }
    }
    try {
      const entries = await readdir(join(changeDir, "specs"), { withFileTypes: true })
      context.scopeCandidates.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    } catch {
      // No delta specs: the composed scope stays omitted (zero capabilities).
    }
  }
  context.scopeCandidates = [...new Set(context.scopeCandidates)].sort()
  return context
}

/**
 * Composes the squash message from the whole reviewed branch range (capability
 * feature-close delta): a bounded model-backed proposal when the writer
 * answers, otherwise the honest deterministic conventional fallback. Scope
 * rules are enforced either way — one touched capability names the scope, zero
 * or several omit it — and selected change IDs ride the body when present.
 */
async function composeCloseMessage(input: {
  checkout: string
  branch: string
  changes: string[]
  context: CloseMessageContext
  pullRequest?: { number: number; title?: string; url: string }
  /** False composes deterministically only (headless mode, design D6). */
  model: boolean
}): Promise<{ message: string; source: "model" | "fallback"; error?: string }> {
  const { closeFallbackCommitMessage, formatCommitMessage, normalizeComposedMessage, proposeCommitMessage } = await import("./commit-message")
  const changeID = input.changes[0]
  const scope = input.context.scopeCandidates.length > 0 ? { scopeCandidates: input.context.scopeCandidates } : {}
  const namedChange = changeID !== undefined ? { changeID } : {}
  if (!input.model) {
    const fallback = closeFallbackCommitMessage({
      branch: input.branch,
      ...(input.context.proposalExcerpt ? { proposal: input.context.proposalExcerpt } : {}),
      ...namedChange,
      ...scope,
      commits: input.context.commits,
    })
    return { message: withPullRequestReference(stripControlBytes(formatCommitMessage(fallback)), input.pullRequest), source: "fallback" }
  }
  const proposal = await proposeCommitMessage({
    targetDir: input.checkout,
    branch: input.branch,
    commits: input.context.commits,
    ...(input.context.diffStat ? { diffStat: input.context.diffStat } : {}),
    ...(input.context.proposalExcerpt ? { proposalExcerpt: input.context.proposalExcerpt } : {}),
    ...scope,
  })
  const normalized =
    proposal.source === "model"
      ? normalizeComposedMessage(proposal.message, { ...scope, ...namedChange })
      : closeFallbackCommitMessage({
          branch: input.branch,
          ...(input.context.proposalExcerpt ? { proposal: input.context.proposalExcerpt } : {}),
          ...namedChange,
          ...scope,
          commits: input.context.commits,
        })
  const message = withPullRequestReference(stripControlBytes(formatCommitMessage(normalized)), input.pullRequest)
  return { message, source: proposal.source === "model" ? "model" : "fallback", ...(proposal.error ? { error: proposal.error } : {}) }
}

/** Appends the GitHub squash reference ` (#N)` to the reviewed subject (never doubled, never a merge claim). */
function withPullRequestReference(message: string, pullRequest?: { number: number }): string {
  if (!pullRequest) return message
  const reference = ` (#${pullRequest.number})`
  const [subjectLine = "", ...rest] = message.split("\n")
  if (/\s*\(#\d+\)$/.test(subjectLine)) return message
  let line = subjectLine
  const overflow = line.length + reference.length - 72
  if (overflow > 0) line = line.slice(0, line.length - overflow)
  line = line.replace(/\s+$/, "")
  return [line + reference, ...rest].join("\n")
}

/**
 * The tolerant open-PR probe for the close branch: found, none, ambiguous, or
 * unavailable — a failed lookup is unavailable evidence, never "no PR" and
 * never a hosted-merge claim (capability feature-close delta). The count is
 * the routing criterion (change `close-lands-via-github-pr`, design D1):
 * exactly one open PR selects the hosted path; an ambiguous match selects the
 * local path without asserting hosted coverage.
 */
export type ClosePullRequestProbe =
  | { status: "found"; number: number; title?: string; url: string }
  | { status: "none" }
  | { status: "ambiguous"; count: number }
  | { status: "unavailable"; reason: string }

async function probeClosePullRequest(
  branch: string,
  cwd: string,
): Promise<ClosePullRequestProbe> {
  let result
  try {
    const gh = await execFile("gh", ["--version"], { cwd: process.cwd(), allowFailure: true })
    if (gh.exitCode !== 0) return { status: "unavailable", reason: "the GitHub CLI is not installed or not usable" }
    result = await execFile("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,title,url"], { cwd, allowFailure: true })
  } catch (error) {
    // allowFailure handles exit codes, but a missing executable throws at spawn.
    return { status: "unavailable", reason: `the GitHub CLI could not be run: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (result.exitCode !== 0) {
    return { status: "unavailable", reason: (result.stderr || result.stdout).trim().slice(0, 200) || "the pull-request query failed" }
  }
  try {
    const rows = JSON.parse(result.stdout) as Array<{ number?: unknown; title?: unknown; url?: unknown }>
    const found = rows.filter(
      (row) => typeof row.number === "number" && Number.isFinite(row.number) && typeof row.url === "string" && row.url,
    )
    if (found.length === 1) {
      const row = found[0]!
      return { status: "found", number: row.number as number, ...(typeof row.title === "string" && row.title ? { title: row.title } : {}), url: row.url as string }
    }
    if (found.length > 1) return { status: "ambiguous", count: found.length }
    return { status: "none" }
  } catch (error) {
    return { status: "unavailable", reason: `the pull-request query returned unreadable output: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Whether the checkout speaks canonical OpenSpec: it carries at least one
 * canonical `spec.md`. This is the conservative gate for the post-archive
 * semantic validation (task 6.2) — a checkout without canonical specs is not
 * an OpenSpec consumer, so refusing to validate there must not be read as a
 * failure, and a test stub CLI in that state must not trip the guard.
 */
async function checkoutHasCanonicalSpecs(checkout: string): Promise<boolean> {
  const specs = await readCheckoutCanonicalSpecs(checkout)
  return specs.kind === "known" && specs.value.length > 0
}

/** Paths whose porcelain state changed between two `git status --porcelain` reads. */
function changedPaths(before: string, after: string): string[] {
  const beforeSet = new Set(
    before
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (line.length > 3 ? line.slice(3).trim() : "")),
  )
  const afterSet = new Set(
    after
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (line.length > 3 ? line.slice(3).trim() : "")),
  )
  return [...beforeSet, ...afterSet].filter((path) => path !== "" && (beforeSet.has(path) !== afterSet.has(path)))
}

// ── remove ───────────────────────────────────────────────────────────────

async function runRemove(command: Extract<WorktreesCommand, { kind: "remove" }>, cwd?: string): Promise<void> {
  const { commonDir } = await repoContext(cwd)
  const outcome = await removeRegisteredWorktree({ checkout: command.worktree, commonDir, force: command.force })
  if (!outcome.ok) return reportBlocked(outcome.blockers, outcome.reason)
  process.stdout.write(
    `removed worktree ${outcome.value.removedPath} (its branch was retained; deletion is a separate action)\n`,
  )
}

// ── delete-branch ────────────────────────────────────────────────────────

async function runDeleteBranch(command: Extract<WorktreesCommand, { kind: "delete-branch" }>, cwd?: string): Promise<void> {
  const dir = (await repoContext(cwd)).cwd
  // A branch checked out anywhere cannot be deleted, and the current process
  // checkout's branch is refused outright (design D8).
  const refuseCheckedOut = async (): Promise<void> => {
    const checkedOutAt = await findWorktreeDirForBranch(command.branch, dir)
    if (checkedOutAt) throw new Error(`branch ${command.branch} is checked out at ${checkedOutAt} — remove that worktree (or switch it) before deleting the branch`)
    const here = await currentBranch(dir)
    if (here === command.branch) throw new Error(`branch ${command.branch} is the current process checkout's branch — switch away before deleting it`)
  }
  await refuseCheckedOut()
  const tip = await resolveCommit(command.branch, dir)
  if (!tip) throw new Error(`branch ${command.branch} does not resolve to a commit in this repository`)

  if (command.force) {
    // Explicit expected-tip consent (design D8): destructive deletion is bound
    // to the exact tip the operator reviewed. `--force` alone is not consent —
    // the operator must name the tip with --expect, and the deletion below is
    // a Git compare-and-delete that refuses if the ref moved after the read
    // above. Neither a receipt, a PR badge, nor tree equality substitutes.
    if (!command.expect) {
      throw new Error(
        `destructive deletion of ${command.branch} requires --expect <oid> naming the exact tip you reviewed (currently ${tip.slice(0, 8)}) — review the tip first, then re-run with --force --expect <oid>`,
      )
    }
    // A prefix match would let a shorter fragment authorize deletion of a
    // tip the operator never reviewed in full (CC-9): consent names the
    // complete 40-character OID or it is not consent.
    const expected = command.expect.toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      throw new Error(
        `--expect must be the full 40-character OID of the reviewed tip (got "${command.expect}") — run \`git rev-parse ${command.branch}\` and pass the complete hash`,
      )
    }
    if (tip !== expected) {
      throw new Error(
        `branch ${command.branch} is at ${tip.slice(0, 8)}, not the reviewed tip ${expected.slice(0, 8)} — the branch moved after review; re-review the current tip and retry with the fresh OID`,
      )
    }
    process.stdout.write(`destructively deleting ${command.branch} at ${tip} — commits not contained in another ref will be lost\n`)
    // Fresh registration check immediately before the effect.
    await refuseCheckedOut()
    // Git-enforced expected-OID protection: `update-ref -d <ref> <oldvalue>`
    // deletes only if the ref still holds exactly the reviewed tip.
    const result = await execFile("git", ["update-ref", "-d", `refs/heads/${command.branch}`, tip], { cwd: dir, allowFailure: true })
    if (result.exitCode !== 0) {
      throw new Error(
        `git refused to delete ${command.branch} at ${tip.slice(0, 8)}: ${(result.stderr || result.stdout).trim()} — the branch changed after review; re-review the current tip and retry`,
      )
    }
    process.stdout.write(`deleted branch ${command.branch}\n`)
    return
  }

  // Normal Git safety: `-d` refuses branches whose history is not contained
  // in another ref (e.g. after a squash), which is where --force applies.
  const result = await execFile("git", ["branch", "-d", "--", command.branch], { cwd: dir, allowFailure: true })
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(
      `git refused to delete ${command.branch}: ${detail}\nIf its unique history is genuinely no longer needed, re-run with --force --expect <oid> after reviewing the tip (${tip.slice(0, 8)}) — that is explicit destructive consent bound to the exact tip.`,
    )
  }
  process.stdout.write(`deleted branch ${command.branch}\n`)
}

// ── legacy-data cleanup (task 8.3) ───────────────────────────────────────

/**
 * The explicitly requested, previewed cleanup of retired feature-lifecycle
 * data (task 8.3): legacy feature records, close journals, and their
 * protective refs. Without `--confirm` it only prints the preview; with it,
 * the listed retired files and refs are removed — never the whole common
 * Convoy directory, and never live state (operations, writer claims, the
 * authoring service record, session hints, run history, or run-compaction
 * refs). Cleanup is refused while any unresolved legacy or new operation
 * could still depend on the evidence, and legacy state stays byte-identical
 * until then.
 */

/** The retired legacy paths and refs the preview lists and --confirm removes. */
async function enumerateLegacyArtifacts(cwd: string, commonDir: string): Promise<{ files: string[]; refs: string[] }> {
  const files: string[] = []
  for (const dir of [join(commonDir, "convoy", "features"), join(commonDir, "convoy", "close")]) {
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    files.push(dir)
  }
  const refs: string[] = []
  const listed = await execFile("git", ["for-each-ref", "--format=%(refname)", "refs/convoy/features/", "refs/convoy/close/"], { cwd, allowFailure: true })
  if (listed.exitCode === 0) refs.push(...listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean))
  return { files, refs }
}

async function runCleanupLegacy(command: Extract<WorktreesCommand, { kind: "cleanup-legacy" }>, cwd?: string): Promise<void> {
  const { cwd: dir, commonDir } = await repoContext(cwd)
  const { listUnresolvedLegacyOperations } = await import("./legacy-operations")
  const { inspectLegacyCloseJournals } = await import("./legacy-operations")
  const { files, refs } = await enumerateLegacyArtifacts(dir, commonDir)

  const blockers: string[] = []
  const unresolvedLegacy = await listUnresolvedLegacyOperations(commonDir)
  if (unresolvedLegacy.length > 0) {
    blockers.push(
      `${unresolvedLegacy.length} unresolved legacy close journal(s) still depend on this evidence — inspect and reconcile them first (\`convoy worktrees recover\` guidance; the journals stay byte-identical until then)`,
    )
  }
  const journals = await inspectLegacyCloseJournals(commonDir)
  const corrupt = journals.filter((journal) => journal.status === "corrupt")
  if (corrupt.length > 0) {
    blockers.push(`${corrupt.length} unreadable/corrupt legacy journal(s) cannot be proven resolved — inspect them by hand before cleanup (${corrupt.map((journal) => journal.path).join(", ")})`)
  }
  const pending = await listPendingOperations(commonDir)
  if (pending.length > 0) {
    blockers.push(`${pending.length} unresolved operation journal(s) exist — resolve or cancel them first (\`convoy worktrees recover --operation <id>\`)`)
  }

  const lines: string[] = ["Legacy data cleanup preview (retired feature-lifecycle files and refs only):"]
  if (files.length === 0 && refs.length === 0) lines.push("  (nothing retired to clean — legacy state is already absent)")
  for (const file of files) lines.push(`  file   ${file}`)
  for (const ref of refs) lines.push(`  ref    ${ref}`)
  lines.push("  never: the common Convoy directory itself, operations/, writer claims, the authoring service record,")
  lines.push("         session hints, run history, run backups, or run-compaction refs and journals.")
  process.stdout.write(`${lines.join("\n")}\n`)

  if (blockers.length > 0) {
    throw new Error(`legacy cleanup is blocked:\n${blockers.map((blocker) => `  - ${blocker}`).join("\n")}`)
  }
  if (!command.confirm) {
    process.stdout.write("\nNothing was removed. Re-run with --confirm to remove exactly the listed retired files and refs.\n")
    return
  }

  const { rm } = await import("node:fs/promises")
  let removedFiles = 0
  for (const file of files) {
    await rm(file, { recursive: true, force: true })
    removedFiles += 1
  }
  let removedRefs = 0
  for (const ref of refs) {
    const deleted = await execFile("git", ["update-ref", "-d", ref], { cwd: dir, allowFailure: true })
    if (deleted.exitCode === 0) removedRefs += 1
  }
  process.stdout.write(`removed ${removedFiles} retired path(s) and ${removedRefs} retired ref(s); everything else is untouched.\n`)
}

// ── recover ──────────────────────────────────────────────────────────────

/**
 * Recovery inspects the named unresolved operation against reality. Without
 * consent it only reports; continuing or cancelling requires the explicit
 * flag, and unexplained evidence blocks in every mode.
 */
async function runRecover(command: Extract<WorktreesCommand, { kind: "recover" }>, cwd?: string): Promise<void> {
  const context = await repoContext(cwd)
  const read = await readOperation(context.commonDir, command.operationId)
  if (read.status === "unsupported") throw new Error(`operation ${command.operationId} uses an unsupported schema version and must not be interpreted`)
  if (read.status !== "found") {
    const pending = await listPendingOperations(context.commonDir)
    throw new Error(
      `operation ${command.operationId} is not a readable pending operation in this repository${pending.length > 0 ? ` (pending operations: ${pending.join(", ")})` : " (no pending operations)"}`,
    )
  }
  const record: OperationRecord = read.value
  // The kind-specific reality probe (task 2.4, gap CC-7): each unacknowledged
  // step is re-observed against the repository — a squash candidate already
  // contained in the reviewed base is recognized as the existing landing, a
  // pushed OID present on the remote-tracking ref is recognized, an archived
  // change that left the active set is recognized — and anything the record
  // cannot explain stays pending or blocks, never replayed blindly.
  const probe: ReconcileProbe = (step, operation) => reconcileStepReality(step, operation, context.cwd)
  const outcome = await recoverOperation({ commonDir: context.commonDir, operationId: command.operationId, gitCwd: context.cwd, probe, consent: command.consent })
  if (outcome.status === "unknown-operation") throw new Error(outcome.reason)
  const lines: string[] = [`operation ${record.operationId} (${record.kind}):`]
  for (const step of outcome.reconciliation) {
    lines.push(`  ${step.stepId}: ${step.state}${step.state === "unexplained" ? ` — ${step.reason}` : ""}`)
  }
  switch (outcome.status) {
    case "blocked":
      lines.push(`blocked: ${outcome.reason}`)
      process.stdout.write(`${lines.join("\n")}\n`)
      process.exitCode = 1
      return
    case "awaiting-consent":
      lines.push(`pending — re-run with --continue (fresh preflight for the remaining steps) or --cancel (safe cancellation)`)
      process.stdout.write(`${lines.join("\n")}\n`)
      process.exitCode = 1
      return
    case "needs-work": {
      // A hosted close's remaining remote steps replay here — the operator's
      // `--continue` is the explicit acceptance the delta spec requires
      // (change `close-lands-via-github-pr`): the already-pushed branch is
      // recognized rather than re-pushed and a merged PR rather than
      // re-merged, by receipt.
      if (isHostedCloseOperation(record)) {
        const inputs = await hostedOperationInputs(context.commonDir, command.operationId)
        if (!inputs) throw new Error(`operation ${command.operationId} is a hosted close whose recorded inputs could not be read — inspect it by hand before retrying`)
        const resumed = await landViaGitHub(inputs)
        if (!resumed.ok) {
          lines.push(`blocked: ${resumed.reason}`)
          process.stdout.write(`${lines.join("\n")}\n`)
          process.exitCode = 1
          return
        }
        lines.push("hosted landing resumed and completed:")
        for (const line of resumed.narration) lines.push(`  - ${line}`)
        lines.push("reconciled — the journal and its protective refs were released")
        process.stdout.write(`${lines.join("\n")}\n`)
        return
      }
      lines.push(`remaining steps stay pending for a fresh preflight: ${outcome.remaining.join(", ")}`)
      process.stdout.write(`${lines.join("\n")}\n`)
      return
    }
    case "reconciled":
      lines.push("reconciled — the journal and its protective refs were released")
      process.stdout.write(`${lines.join("\n")}\n`)
      return
    case "cancelled":
      lines.push("cancelled — remaining steps were explicitly cancelled and the journal was released")
      process.stdout.write(`${lines.join("\n")}\n`)
      return
  }
}

// ── run selection validation (design D4) ─────────────────────────────────

/**
 * Validates the explicit run selection against the execution checkout: every
 * selected change must exist in THIS checkout — a missing selected source
 * stops, never a same-id copy from another checkout (delta run-launcher).
 */
export async function validateRunSelection(worktree: string, changes: string[]): Promise<void> {
  if (changes.length === 0) return
  const local = await readCheckoutActiveChanges(worktree)
  if (local.kind !== "known") throw new Error(`the selected checkout's active changes could not be read: ${local.reason}`)
  const present = new Set(local.value.map((change) => change.changeId))
  const missing = changes.filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new Error(`selected change(s) not found in ${worktree}: ${missing.join(", ")} — select changes that exist in this checkout (never a same-id copy from another one)`)
  }
}

// ── shared reporting ─────────────────────────────────────────────────────

/** The blocker/remediation text the shared seam renders for a blocked operation. */
export function formatBlockers(blockers: Array<{ reason: string; remediation: string }>, reason?: "stale-review" | "blocked"): string {
  const lines: string[] = []
  if (reason === "stale-review") lines.push("the reviewed target changed before execution — nothing was mutated")
  for (const blocker of blockers) {
    lines.push(`blocked: ${blocker.reason}`)
    lines.push(`  remediation: ${blocker.remediation}`)
  }
  return lines.join("\n")
}

/** The default headless blocked reporter: prints blockers to stderr and exits non-zero. */
function writeBlockedStderr(blockers: Array<{ reason: string; remediation: string }>, reason?: "stale-review" | "blocked"): void {
  process.stderr.write(`${formatBlockers(blockers, reason)}\n`)
  process.exitCode = 1
}

type BlockedReporter = (blockers: Array<{ reason: string; remediation: string }>, reason?: "stale-review" | "blocked") => void

/** The active blocked reporter the shared seam routes every blocked outcome through. */
let blockedSink: BlockedReporter = writeBlockedStderr

/** The shared seam's blocker path (task 7.9): routes to the active reporter instead of swallowing. */
export function reportBlocked(blockers: Array<{ reason: string; remediation: string }>, reason?: "stale-review" | "blocked"): void {
  blockedSink(blockers, reason)
}

/**
 * Runs `fn` with the blocked reporter overridden to a launching-surface sink
 * (capability worktree-operations, task 7.9): a blocked menu action renders its
 * blockers and remediations as a visible notice instead of writing to an
 * unwritten stderr stream and silently returning to the menu. The sink is
 * always restored (default headless stderr reporting) when `fn` settles.
 */
export async function withBlockedReporter<T>(sink: BlockedReporter, fn: () => Promise<T>): Promise<T> {
  const previous = blockedSink
  blockedSink = sink
  try {
    return await fn()
  } finally {
    blockedSink = previous
  }
}

// ── `convoy close` (capability feature-close, design D4/D8/D11) ──────────

export function closeCommandHelp(): string {
  return `convoy close — the optional composition of the worktree operations

Close reviews an explicit checkout and base, syncs as needed, archives the
explicitly selected local changes (zero is valid), then lands the WHOLE
reviewed branch as one commit on the base. Selecting changes controls what is
archived, never the landing scope. Without a linked open pull request the
landing is a local squash and nothing is pushed or merged on a hosting service;
push, worktree removal, and branch deletion remain separate actions
(\`convoy worktrees push|remove|delete-branch\`). When close detects exactly one
open PR for the branch through usable GitHub evidence, the landing is hosted
instead: the branch is pushed (non-force), GitHub squash-merges that PR with
the reviewed message, and the local base is fast-forwarded to GitHub's squash
commit — the remote steps are disclosed before any effect.

Usage:
  convoy close [--worktree <path> | --branch <name>] [--base <local-branch>]
               [--change <id> ...] [--message <text>] [--local-landing] [--dry-run]

Target selection:
  --worktree <path>  Close this registered checkout explicitly.
  --branch <name>    Resolve the checkout carrying this branch through Git's
                     worktree inventory; refused unless it resolves uniquely.
  (neither)          The checkout the current process runs in — validated like
                     any other target, never a hidden fallback.

Options:
  --base <ref>         The local base branch to integrate onto (default: the
                       repository's detected base, disclosed before mutation).
  --change <id>        Archive this explicitly selected local active change;
                       repeat for an ordered batch. Incomplete or unknown tasks
                       block the ordinary archive.
  --message <text>     Exact message for the squash commit; skips composition.
  --local-landing      Keep the landing local even when a linked open PR
                       enables the hosted path.
  --dry-run            Print the reviewed sequence without touching anything.

Retired spellings (exit non-zero before any effect):
  --feature <id>     Feature identity is retired — select a worktree instead.
  --cleanup ...      Cleanup is independent: \`convoy worktrees remove\` and
                     \`convoy worktrees delete-branch\`.
  --resume           Recovery is operation-scoped: \`convoy worktrees recover
                     --operation <id>\`.
`
}

export type CloseCommandOptions = {
  worktree?: string
  branch?: string
  base?: string
  changes: string[]
  message?: string
  localLanding?: boolean
  dryRun: boolean
  /** Retired spellings, recognized only to fail with guidance. */
  feature?: string
  cleanup?: string
  resume?: boolean
}

export function parseCloseCommandArgs(argv: string[]): CloseCommandOptions {
  const options: CloseCommandOptions = { changes: [], dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value\n\n${closeCommandHelp()}`)
      return next
    }
    if (arg === "--help" || arg === "-h") throw new Error(closeCommandHelp())
    else if (arg === "--worktree" || arg.startsWith("--worktree=")) options.worktree = arg === "--worktree" ? value() : arg.slice("--worktree=".length)
    else if (arg === "--worktree-dir" || arg.startsWith("--worktree-dir=")) options.worktree = arg === "--worktree-dir" ? value() : arg.slice("--worktree-dir=".length)
    else if (arg === "--branch" || arg.startsWith("--branch=")) options.branch = arg === "--branch" ? value() : arg.slice("--branch=".length)
    else if (arg === "--base" || arg.startsWith("--base=")) options.base = arg === "--base" ? value() : arg.slice("--base=".length)
    else if (arg === "--change" || arg.startsWith("--change=")) options.changes.push(arg === "--change" ? value() : arg.slice("--change=".length))
    else if (arg === "--message" || arg.startsWith("--message=")) options.message = arg === "--message" ? value() : arg.slice("--message=".length)
    else if (arg === "--local-landing") options.localLanding = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--feature" || arg.startsWith("--feature=")) options.feature = arg === "--feature" ? value() : arg.slice("--feature=".length)
    else if (arg === "--cleanup" || arg.startsWith("--cleanup=")) options.cleanup = arg === "--cleanup" ? value() : arg.slice("--cleanup=".length)
    else if (arg === "--resume") options.resume = true
    else throw new Error(`unexpected argument: ${arg}\n\n${closeCommandHelp()}`)
  }
  return options
}

/**
 * The `convoy close` entry point (gap CC-3): the same composite the Worktrees
 * board and `convoy worktrees close` run — never a second close engine.
 * Legacy branch selectors are accepted only when they resolve uniquely to a
 * live registered checkout; feature-id flags and cleanup/resume spellings
 * stop with migration guidance before any Git effect.
 */
export async function runCloseCommandFromArgs(options: CloseCommandOptions, cwd?: string): Promise<void> {
  const dir = cwd ?? process.cwd()
  if (options.feature !== undefined) {
    throw new Error(
      `--feature was removed: feature identity is retired (capability feature-lifecycle). Select the worktree to close instead — \`convoy close --worktree <path>\` or \`convoy close --branch <name>\`.`,
    )
  }
  if (options.cleanup !== undefined) {
    throw new Error(
      `--cleanup was removed: cleanup is independent of close. Use \`convoy worktrees remove --worktree <path>\` for the checkout and \`convoy worktrees delete-branch --branch <name>\` for its branch.`,
    )
  }
  if (options.resume) {
    throw new Error(`--resume was removed: close recovery is operation-scoped — run \`convoy worktrees recover --operation <id>\` (pending operations are listed when the id is unknown).`)
  }
  if (options.dryRun) {
    const target = options.worktree ?? options.branch ?? dir
    process.stdout.write(`close would run: review → sync (as needed) → archive ${options.changes.length > 0 ? options.changes.join(", ") : "(no changes selected)"} → ${options.localLanding ? "whole-branch squash" : "whole-branch landing (hosted via the linked PR when one is detected, otherwise a local squash)"} onto ${options.base ?? "the detected base"}\n`)
    process.stdout.write(`target: ${target}\n`)
    if (options.localLanding) {
      process.stdout.write("push, worktree removal, and branch deletion stay separate actions; nothing is pushed or merged on a hosting service.\n")
    } else {
      process.stdout.write("without a linked open pull request nothing is pushed or merged; when one is detected, the disclosed hosted landing pushes the branch and asks GitHub to squash-merge that PR.\n")
    }
    return
  }

  // Resolve the target: an explicit checkout path, a branch selector resolved
  // uniquely through Git's inventory, or the current process checkout —
  // validated like any other target, never guessed across checkouts.
  let checkout = options.worktree
  if (!checkout && options.branch) {
    const commonDir = await repoCommonDir(dir)
    if (!commonDir) throw new Error("not a git repository — `convoy close` operates on the current repository")
    const resolved = await requireAgreeingSelectors({ branch: options.branch, commonDir })
    if (!resolved.ok) throw new Error(`the branch selector "${options.branch}" does not resolve uniquely to a live checkout: ${resolved.reason}`)
    checkout = resolved.target.checkoutPath
  }
  checkout ??= dir

  // The base: the explicit review input, else the repository's detected base
  // as a disclosed suggestion (design D5) — never a silent `main` assumption.
  let base = options.base
  if (!base) {
    const detected = await detectBaseRef(dir).catch(() => undefined)
    base = detected?.ref
  }
  if (!base) {
    throw new Error("no base could be detected — pass --base <local-branch> naming the branch to integrate onto")
  }

  await runWorktreeClose(
    {
      checkout,
      base,
      changes: options.changes,
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.localLanding ? { localLanding: true } : {}),
    },
    dir,
  )
}
