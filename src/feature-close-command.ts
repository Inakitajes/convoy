import { stdout } from "node:process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"

import { archiveChangeOnMain, runClose, runCloseCleanup, verifiedCloseReceipt, type CloseEvent, type CloseInput, type CloseMessageProposal, type CloseResult, type CloseStep, type DetectedPullRequest } from "./feature-close"
import { stripControlBytes } from "./commit-text"
import {
  applyCloseEvent,
  initialCloseChecklistState,
  renderCloseChecklist,
  type CloseChecklistRow,
  type CloseChecklistRowStatus,
  type CloseChecklistState,
} from "./close-presentation"
import { branchUpstream, execFile, mainWorktreeDir, pushRefspec, removeWorktree } from "./git"
import { log } from "./log"
import { ask, isInteractiveTerminal } from "./terminal-input"
import type {
  CloseDeferredCleanup,
  CloseDeferredStep,
  CloseFollowUpId,
  CloseFollowUpItem,
  CloseFollowUpsView,
  CloseTui,
} from "./close-tui"
import type { TuiRoute } from "./tui-session"

export {
  applyCloseEvent,
  initialCloseChecklistState,
  renderCloseChecklist,
  type CloseChecklistRow,
  type CloseChecklistRowStatus,
  type CloseChecklistState,
} from "./close-presentation"

/**
 * The `convoy close` command surface. One close sequence, two renderers
 * (design D3/D6): in a TTY the sequence renders as a live checklist with the
 * composed message confirmed before it lands and deliberate follow-up offers;
 * headless, the same event stream prints as a factual stdout summary whose
 * follow-up commands are executable and safe, and nothing interactive is
 * attempted.
 */

export type CloseOptions = {
  targetDir: string
  /** Finish a feature worktree by branch instead of the current directory. */
  branch?: string
  /** The worktree directory, when the caller (the board) already resolved it. */
  worktreeDir?: string
  changeID?: string
  /** Explicit stable feature id: identity-keyed resolution, resume, and cleanup (design D3/D9). */
  featureId?: string
  /** Cleanup-only continuation of a verified landing: `worktree` then `branch`. */
  cleanup?: "worktree" | "branch"
  /** Continue a stopped sequence from the first incomplete step. */
  resume?: boolean
  message?: string
  /** Print what would happen's inputs and exit without touching the repo. */
  dryRun?: boolean
  help?: boolean
}

export async function runCloseCommand(options: CloseOptions, route?: TuiRoute): Promise<void> {
  if (options.dryRun) {
    stdout.write(`close would run: preflight → sync → archive → squash-merge${options.resume ? " (resuming)" : ""}\n`)
    return
  }
  // Cleanup is its own deliberate surface (design D9): the feature-keyed
  // guarded commands the TUI and headless output print are executable here,
  // running the same action-time revalidation as the TUI follow-ups.
  if (options.cleanup) {
    try {
      const outcome = await runCloseCleanup({
        targetDir: options.targetDir,
        ...(options.featureId ? { featureId: options.featureId } : {}),
        ...(options.worktreeDir ? { worktreeDir: resolve(options.worktreeDir) } : {}),
        cleanup: options.cleanup,
      })
      stdout.write(`${outcome}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stdout.write(`${firstLine(message)}\n`)
      log.error(message)
      process.exitCode = 1
    }
    return
  }
  const input: CloseInput = {
    targetDir: options.targetDir,
    ...(options.worktreeDir ? { worktreeDir: resolve(options.worktreeDir) } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.changeID ? { changeID: options.changeID } : {}),
    ...(options.featureId ? { featureId: options.featureId } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
  }
  // The board's close-change handoff lands here too: a TTY gets the checklist,
  // a pipe gets the stdout summary — one dispatcher, no second call site.
  if (closeSurface() === "tty") await runCloseInteractive(input, {}, route)
  else await runCloseHeadless(input)
}

/** Which renderer the command surface uses; a seam so mode selection stays testable. */
export function closeSurface(interactive: boolean = isInteractiveTerminal()): "tty" | "headless" {
  return interactive ? "tty" : "headless"
}

// ---------------------------------------------------------------------------
// Headless: the event stream printed as a factual stdout summary
// ---------------------------------------------------------------------------

export async function runCloseHeadless(input: CloseInput): Promise<void> {
  const events: CloseEvent[] = []
  let result: CloseResult | undefined
  let failure: string | undefined
  try {
    result = await runClose({ ...input, onEvent: (event) => events.push(event) })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  if (result) {
    const evidence = await verifiedCloseReceipt(input.targetDir, result.branch, result.changeID)
    const followUps = await resolveCloseFollowUps({
      targetDir: input.targetDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
      ...(result.featureId ?? input.featureId ? { featureId: result.featureId ?? input.featureId } : {}),
      ...(evidence ? { evidence: { landingSha: evidence.landingSha, featureTip: evidence.postArchiveTip } } : {}),
      ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
    })
    stdout.write(formatCloseEvents(events, { followUps }))
    return
  }
  stdout.write(formatCloseEvents(events, { failure }))
  log.error(failure ?? "close failed")
}

/**
 * The headless formatter over the close event stream (task 3.1): per-step
 * final states, the merge shape, and — on success — the follow-up commands in
 * safe execution order (push, worktree removal, branch deletion). Push prints
 * its explicit remote and refspec, or a remediation when no upstream exists —
 * never an invalid bare `git push main`.
 */
export function formatCloseEvents(events: readonly CloseEvent[], extra: { followUps?: CloseFollowUps; failure?: string } = {}): string {
  const lines: string[] = []
  const stepState = new Map<CloseStep, string>()

  for (const event of events) {
    switch (event.type) {
      case "preflight":
        lines.push(`preflight: ${event.summary}`)
        break
      case "preflight-failed":
        lines.push("preflight failed:")
        for (const blocker of event.blockers) lines.push(`  ${blocker.message}`)
        break
      case "step-started":
        break
      case "step-completed":
        stepState.set(event.step, event.detail ? `${event.step}: ${strip(event.detail)}` : `${event.step}: completed`)
        break
      case "step-skipped":
        stepState.set(event.step, `${event.step}: skipped — ${strip(event.reason)}`)
        break
      case "step-failed":
        stepState.set(event.step, `${event.step}: failed — ${strip(firstLine(event.message))}`)
        break
      case "squash-phase":
        // Intermediate squash-merge sub-phases stay out of the stdout summary;
        // the step's final state carries the same facts (design D8).
        break
      case "result":
        lines.push(...stepState.values())
        lines.push(closeResultLine(event.result))
        if (extra.followUps) lines.push(...formatCloseFollowUps(extra.followUps))
        break
    }
  }
  // A stop never reaches the result event: the per-step states carry the story.
  if (!events.some((event) => event.type === "result")) lines.push(...stepState.values())
  if (extra.failure) lines.push(firstLine(extra.failure))
  return `${lines.join("\n")}\n`
}

/** The follow-up cleanup, resolved from git state (design D7). */
export type CloseFollowUps = {
  /** Present only when the base branch has a configured upstream. */
  push?: { remote: string; refspec: string; command: string }
  /** The concrete setup step when push is unavailable; never an invalid push command. */
  pushRemediation?: string
  /** The worktree-removal command, present while the worktree still exists. */
  worktreeRemoval?: string
  branchDelete?: string
  /** Why branch deletion is unavailable; never an unguarded delete command. */
  branchDeleteRemediation?: string
  /**
   * Present only when close detected an open pull request for the feature
   * branch (PR-aware close): the deliberate fallback close command for the
   * case where GitHub has not marked the PR merged after the landing is
   * pushed, plus the PR's URL for inspection. Printed guidance only — close
   * never mutates GitHub state itself.
   */
  prFallback?: { number: number; url?: string; command: string }
}

/**
 * Resolves what cleanup is even possible: the base branch's configured
 * upstream becomes an explicit push refspec; a worktree that still exists and
 * isn't the main checkout gets a removal command; branch deletion follows the
 * worktree's dependency.
 */
/**
 * The verified landing evidence cleanup requires (design D7, task 6.3):
 * produced by `verifiedCloseReceipt` in feature-close — a receipt naming the
 * exact feature tip and a landing commit still reachable from the base.
 * A squash landing leaves no merge ancestry, so nothing else is evidence.
 */
export type CloseLandingEvidence = {
  landingSha: string
  featureTip: string
}

export async function resolveCloseFollowUps(args: {
  targetDir: string
  baseRef: string
  branch: string
  worktreeDir: string
  /** The resolved feature: cleanup then prints the feature-keyed guarded commands (design D9). */
  featureId?: string
  /** Present only when a verified receipt authorizes branch deletion. */
  evidence?: CloseLandingEvidence
  /** The open pull request close detected for the feature branch (PR-aware close). */
  pullRequest?: DetectedPullRequest
}): Promise<CloseFollowUps> {
  const mainDir = (await mainWorktreeDir(args.targetDir).catch(() => undefined)) ?? args.targetDir
  // Every printed command is prefixed `git -C <mainDir>` and quotes only the
  // path tokens, so it is executable from inside the feature worktree (the
  // natural close cwd) and survives paths with spaces (SC-2).
  const gitC = `git -C ${shq(mainDir)}`

  let push: CloseFollowUps["push"]
  let pushRemediation: string | undefined
  const upstream = await branchUpstream(args.baseRef, mainDir).catch(() => undefined)
  const [remote, ...remoteRest] = (upstream ?? "").split("/")
  const remoteBranch = remoteRest.join("/")
  if (remote && remoteBranch) {
    push = { remote, refspec: `${args.baseRef}:${remoteBranch}`, command: `${gitC} push ${shq(remote)} ${shq(args.baseRef)}:${shq(remoteBranch)}` }
  } else {
    pushRemediation = `${shq(args.baseRef)} has no configured upstream — set one first: ${gitC} branch --set-upstream-to=<remote>/<branch> ${shq(args.baseRef)}`
  }

  // Cleanup commands are the feature-keyed guarded operations (design D9):
  // `convoy close --feature <id> --cleanup worktree` then `--cleanup branch`.
  // They execute the same identity-aware checks the TUI actions do — fresh
  // association, unresolved-attempt, live-run, and mutation-lease checks on
  // top of the landing evidence — so a deferred or headless operator never
  // falls back to a display-only git recipe. The raw git forms below remain
  // only as the pre-identity display for synthetic callers with no feature.
  let worktreeRemoval: string | undefined
  const isMainCheckout = (await sameDir(mainDir, args.worktreeDir)) === true
  const worktreeExists = await stat(args.worktreeDir).then(
    () => true,
    () => false,
  )
  if (args.featureId) {
    if (!isMainCheckout && worktreeExists) worktreeRemoval = `convoy close --feature ${shq(args.featureId)} --cleanup worktree`
  } else if (!isMainCheckout && worktreeExists) {
    worktreeRemoval = `${gitC} worktree remove ${shq(args.worktreeDir)}`
  }

  // Branch deletion is evidence-gated (design D7, task 6.3): a locally
  // squash-landed branch has no merge ancestry, so plain `branch -d` refuses
  // it and force deletion is permitted ONLY behind a verified receipt naming
  // the exact current feature tip and a landing still reachable from the
  // base. With the feature id the printed command IS the guarded operation —
  // it re-verifies the association, receipt, tip, worktree inventory, and
  // lease at action time and refuses a moved tip with its diagnostic — so
  // the old check-then-delete shell recipe is no longer the safety
  // mechanism. Without a receipt there is no deletion command at all — only
  // the inspection guidance.
  let branchDelete: string | undefined
  let branchDeleteRemediation: string | undefined
  if (args.evidence) {
    if (args.featureId) {
      branchDelete = `convoy close --feature ${shq(args.featureId)} --cleanup branch`
    } else {
      const tipNow = await execFile("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${args.branch}`], {
        cwd: mainDir,
        allowFailure: true,
      })
      if (tipNow.exitCode === 0 && tipNow.stdout.trim() === args.evidence.featureTip) {
        // The final act is the atomic expected-tip ref deletion (task 7.6): the
        // printed checks re-verify tip and reachability, and `update-ref -d`
        // refuses if the branch moved between the check and the deletion.
        branchDelete =
          `${gitC} rev-parse --verify refs/heads/${shq(args.branch)} | grep -qx ${shq(args.evidence.featureTip)} && ` +
          `${gitC} merge-base --is-ancestor ${shq(args.evidence.landingSha)} ${shq(args.baseRef)} && ` +
          `! ${gitC} worktree list --porcelain | grep -qx ${shq(`branch refs/heads/${args.branch}`)} && ` +
          `${gitC} update-ref -d refs/heads/${shq(args.branch)} ${shq(args.evidence.featureTip)}`
      } else if (tipNow.exitCode === 0) {
        branchDeleteRemediation = `${args.branch}'s tip moved past the landed state (${tipNow.stdout.trim().slice(0, 8)}) — inspect the branch before deleting anything`
      } else {
        branchDeleteRemediation = `${args.branch} no longer exists locally — nothing to delete`
      }
    }
  } else {
    branchDeleteRemediation =
      "no verified landing receipt names this branch — deletion needs the receipt close recorded (landing commit reachable from the base and an unchanged feature tip)"
  }

  // The PR fallback (PR-aware close): a detected open pull request gets the
  // deliberate close command naming the base and the landing SHA, so the PR is
  // never left dangling when GitHub has not marked it merged after the push.
  // Guidance only: like push, it is the operator's decision to run.
  let prFallback: CloseFollowUps["prFallback"]
  if (args.pullRequest && args.evidence) {
    prFallback = {
      number: args.pullRequest.number,
      ...(args.pullRequest.url ? { url: args.pullRequest.url } : {}),
      command: `gh pr close ${args.pullRequest.number} --comment ${shq(`landed in ${args.baseRef} as ${args.evidence.landingSha}`)}`,
    }
  }

  return {
    ...(push ? { push } : {}),
    ...(pushRemediation ? { pushRemediation } : {}),
    ...(worktreeRemoval ? { worktreeRemoval } : {}),
    ...(branchDelete ? { branchDelete } : {}),
    ...(branchDeleteRemediation ? { branchDeleteRemediation } : {}),
    ...(prFallback ? { prFallback } : {}),
  }
}

/**
 * The one landing line (design D8): one result, named base, named commit —
 * never a fast-forward/merge-commit shape narration, which described the old
 * ordinary merge this landing replaced.
 */
export function closeResultLine(result: CloseResult): string {
  const base = `closed ${result.changeID}: ${result.branch} → ${result.baseRef}`
  if (result.disposition === "landed" && result.landing) return `${base} (one commit ${result.landing.sha.slice(0, 8)})`
  if (result.disposition === "already-landed" && result.landing) return `${base} (already landed as ${result.landing.sha.slice(0, 8)})`
  return `${base} (no content to land)`
}

/** The printed follow-up block, in the order a safe execution would run. */
export function formatCloseFollowUps(followUps: CloseFollowUps): string[] {
  const lines = ["", "optional follow-ups (never automatic):"]
  if (followUps.push) lines.push(`  ${followUps.push.command}`)
  else if (followUps.pushRemediation) lines.push(`  push unavailable — ${followUps.pushRemediation}`)
  if (followUps.prFallback) {
    // Factual disclosure, never a merge assertion: GitHub may mark the PR
    // merged through the landing subject's (#N) reference once the push lands;
    // the printed command is the deliberate fallback when it has not.
    const pr = followUps.prFallback.number
    lines.push(
      `  pull request #${pr}${followUps.prFallback.url ? ` (${followUps.prFallback.url})` : ""} is open for this branch — after the push, if GitHub has not marked it merged, close it deliberately:`,
    )
    lines.push(`  ${followUps.prFallback.command}`)
  }
  if (followUps.worktreeRemoval) lines.push(`  ${followUps.worktreeRemoval}`)
  if (followUps.branchDelete) lines.push(`  ${followUps.branchDelete}`)
  else if (followUps.branchDeleteRemediation) lines.push(`  branch deletion unavailable — ${followUps.branchDeleteRemediation}`)
  return lines
}

// ---------------------------------------------------------------------------
// TTY: the live checklist, the message gate, and the deliberate cleanups
// ---------------------------------------------------------------------------

export async function runCloseInteractive(input: CloseInput, io: CloseIO = {}, route?: TuiRoute): Promise<void> {
  // `io` remains on the signature for backwards-compatible unit seams around
  // the plain prompt helpers below. Production interactive close owns an
  // OpenTUI alternate screen from the first preflight event to cleanup.
  void io
  const { openCloseTui } = await import("./close-tui")
  const tui = await openCloseTui(input.targetDir, undefined, route)
  try {
    const result = await runClose({
      ...input,
      onEvent: (event) => tui.onEvent(event),
      withTerminal: (action) => tui.withTerminal(action),
      // The TUI owns the reviewed message and the inline editor (design D4):
      // it returns only an explicitly accepted final string, or undefined to
      // stop the sequence before the squash. No external editor participates.
      resolveMessage: (proposal) => tui.confirmMessage(proposal),
    })
    const evidence = await verifiedCloseReceipt(input.targetDir, result.branch, result.changeID)
    const featureId = result.featureId ?? input.featureId
    const followUps = await resolveCloseFollowUps({
      targetDir: input.targetDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
      ...(featureId ? { featureId } : {}),
      ...(evidence ? { evidence: { landingSha: evidence.landingSha, featureTip: evidence.postArchiveTip } } : {}),
      ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
    })
    await offerCloseFollowUpsTui(tui, {
      ...followUps,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
      targetDir: input.targetDir,
      ...(featureId ? { featureId } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
    // Keep the failed checklist and remediation inside the TUI until the
    // operator dismisses it; no cursor-control fragments leak into the shell.
    await tui.showFailure(message)
  } finally {
    tui.destroy()
  }
}

// -- message gate ---------------------------------------------------------------

/** Injectable terminal I/O, so the interactive surfaces stay key-driver testable. */
export type CloseIO = {
  input?: Readable
  output?: {
    write(text: string): unknown
  }
}

/**
 * The TTY side of the resolver gate (design D4), kept as a plain-prompt seam
 * beside the OpenTUI surface. The operator accepts the composed proposal or
 * declines; editing happens inline in the Close TUI, so no $EDITOR participates
 * in Close anywhere. A declined prompt returns undefined, which stops the
 * sequence before the squash lands; nothing commits before the choice.
 */
export async function confirmCloseMessage(
  proposal: CloseMessageProposal,
  deps: { renderer?: { break(): void } } & CloseIO = {},
): Promise<string | undefined> {
  deps.renderer?.break()
  const out = deps.output ?? stdout
  out.write("\n")
  if (proposal.error) out.write("(the writing model failed, so this message is derived from the proposal and the step commits)\n")
  out.write(`${indent(strip(proposal.message))}\n\n`)
  const answer = await ask("Commit with this message? [y/N] ", deps)
  if (answer === "y") return proposal.message
  return undefined
}

// -- follow-up offers -------------------------------------------------------------

export type FollowUpOffers = CloseFollowUps & {
  baseRef: string
  branch: string
  worktreeDir: string
  targetDir: string
  /** The verified receipt the deletion offer is gated on, when present. */
  evidence?: CloseLandingEvidence
  /** The resolved feature: present for every close the adoption gate lets through. */
  featureId?: string
}

/**
 * The action-time recheck (task 6.3): the guards are re-verified immediately
 * before a deletion runs, not just when the offer was printed — a branch that
 * advanced (or a landing that left the base) between offer and action refuses
 * instead of deleting new work.
 */
async function assertLandingEvidenceIntact(mainDir: string, followUps: FollowUpOffers): Promise<void> {
  const evidence = followUps.evidence
  if (!evidence) throw new Error("branch deletion needs a verified landing receipt; none exists")
  const tip = await execFile("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${followUps.branch}`], { cwd: mainDir, allowFailure: true })
  if (tip.exitCode !== 0) throw new Error(`${followUps.branch} no longer exists locally; nothing to delete`)
  if (tip.stdout.trim() !== evidence.featureTip) {
    throw new Error(`${followUps.branch}'s tip moved past the landed state — inspect the branch before deleting it`)
  }
  const reachable = await execFile("git", ["merge-base", "--is-ancestor", evidence.landingSha, followUps.baseRef], { cwd: mainDir, allowFailure: true })
  if (reachable.exitCode !== 0) {
    throw new Error(`the landing commit ${evidence.landingSha.slice(0, 8)} is no longer reachable from ${followUps.baseRef} — inspect the history before deleting anything`)
  }
  await assertNoRegisteredWorktree(mainDir, followUps.branch)
}

/**
 * No registered worktree may have the branch checked out (design D9, task
 * 7.6): Git's worktree inventory — never a path guess — decides, so a reused
 * branch name at a surviving worktree is never deleted under anyone.
 */
async function assertNoRegisteredWorktree(mainDir: string, branch: string): Promise<void> {
  const list = await execFile("git", ["worktree", "list", "--porcelain"], { cwd: mainDir, allowFailure: true })
  if (list.exitCode !== 0) throw new Error("couldn't read the worktree inventory — refusing to delete the branch while registration is unverifiable")
  if (list.stdout.split("\n").includes(`branch refs/heads/${branch}`)) {
    throw new Error(`${branch} is checked out in a registered worktree — remove that worktree before deleting the branch`)
  }
}

/**
 * The guarded branch deletion (task 7.6): an expected-tip ref deletion —
 * `git update-ref -d refs/heads/<branch> <expectedTip>` — is atomic, so a
 * branch that moved between the tip check and the deletion makes the
 * expected-old value refuse. Never `branch -D` after a separate tip test.
 */
async function guardedBranchDeletion(mainDir: string, followUps: FollowUpOffers): Promise<void> {
  await assertLandingEvidenceIntact(mainDir, followUps)
  const result = await execFile("git", ["update-ref", "-d", `refs/heads/${followUps.branch}`, followUps.evidence!.featureTip], { cwd: mainDir, allowFailure: true })
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || `the expected-tip deletion of ${followUps.branch} was refused`).trim())
  }
}

/** In-session outcomes of actions the TUI already ran; drives the next view. */
export type CloseInteractiveFollowUpState = Partial<
  Record<CloseFollowUpId, { status: "running" | "completed" | "failed"; error?: string }>
>

/**
 * Resolves the follow-up presentation (task 3.1, design D5): which cleanups
 * are actions of the current session (runnable now, retryable after failure,
 * or blocked behind another same-session action), which are a remediation
 * notice, and which are deferred cleanup that requires the operator to leave
 * the feature worktree — presented as a reason plus ordered copyable
 * commands, never as actions that could become runnable in this session.
 */
export async function buildCloseFollowUpsView(args: {
  followUps: FollowUpOffers
  /** Injectable for tests; defaults to whether the process cwd is inside the worktree. */
  cwdInside?: boolean
  state?: CloseInteractiveFollowUpState
}): Promise<CloseFollowUpsView> {
  const { followUps } = args
  const state = args.state ?? {}
  const cwdInside = args.cwdInside ?? processCwdInside(followUps.worktreeDir)
  const worktreeExists = await stat(followUps.worktreeDir).then(
    () => true,
    () => false,
  )

  const actions: CloseFollowUpItem[] = []
  let notice: string | undefined

  // The PR fallback rides the follow-ups notice (PR-aware close): informational
  // guidance, never a selectable action — unlike worktree/branch cleanup it has
  // no local git evidence to revalidate, and the push must happen first anyway.
  if (followUps.prFallback) {
    notice = [
      `pull request #${followUps.prFallback.number}${followUps.prFallback.url ? ` (${followUps.prFallback.url})` : ""} is open for ${followUps.branch} — after the push, if GitHub has not marked it merged, close it deliberately:`,
      followUps.prFallback.command,
    ].join("\n")
  }

  // Push is independent of the worktree (design D5) and remains an action in
  // both launch locations. A missing upstream is a remediation, not a
  // fabricated action.
  if (followUps.push) {
    actions.push({
      id: "push",
      label: `Push ${followUps.baseRef}`,
      detail: `Push to ${followUps.push.remote} with the explicit refspec ${followUps.push.refspec}.`,
      command: followUps.push.command,
      status: state.push?.status ?? "available",
      ...(state.push?.error ? { error: state.push.error } : {}),
    })
  } else if (followUps.pushRemediation) {
    notice = notice ? `${notice}\n${followUps.pushRemediation}` : followUps.pushRemediation
  }

  if (cwdInside) {
    // The parent shell must leave the worktree before either cleanup can run:
    // a process cannot remove the directory it sits in, so neither operation
    // enters the action list (design D5).
    const steps: CloseDeferredStep[] = []
    if (followUps.worktreeRemoval && worktreeExists) {
      steps.push({ label: "Remove the feature worktree", command: followUps.worktreeRemoval })
    }
    if (followUps.branchDelete) {
      steps.push({ label: `Delete the local ${followUps.branch} branch`, command: followUps.branchDelete })
    }
    const deferred: CloseDeferredCleanup = {
      reason:
        `convoy close was launched from inside ${followUps.worktreeDir}. ` +
        "A process cannot remove the directory its shell sits in — leave the worktree in your terminal, then run:",
      steps,
    }
    return { actions, notice, deferred }
  }

  if (state.worktree?.status === "completed") {
    actions.push({ id: "worktree", label: "Remove worktree", detail: followUps.worktreeDir, status: "completed" })
  } else if (followUps.worktreeRemoval && worktreeExists) {
    actions.push({
      id: "worktree",
      label: "Remove worktree",
      detail: followUps.worktreeDir,
      command: followUps.worktreeRemoval,
      status: state.worktree?.status ?? "available",
      ...(state.worktree?.error ? { error: state.worktree.error } : {}),
    })
  }
  // A worktree that was already removed (by hand or between sessions) simply
  // omits the removal action; the branch deletion below unlocks accordingly.

  if (state.branch?.status === "completed") {
    actions.push({ id: "branch", label: `Delete ${followUps.branch}`, detail: "Feature branch deleted.", status: "completed" })
  } else if (worktreeExists) {
    actions.push({
      id: "branch",
      label: `Delete ${followUps.branch}`,
      detail: "Remove the feature worktree first; git cannot delete a checked-out branch.",
      command: followUps.branchDelete,
      status: "blocked",
    })
  } else {
    actions.push({
      id: "branch",
      label: `Delete ${followUps.branch}`,
      detail: "Delete the local feature branch after its worktree is gone.",
      command: followUps.branchDelete,
      status: state.branch?.status ?? "available",
      ...(state.branch?.error ? { error: state.branch.error } : {}),
    })
  }
  return { actions, notice }
}

/**
 * Optional cleanup in the OpenTUI surface (task 3.2). Selectable actions stay
 * keyboard-driven, failed actions retry, and deferred cleanup renders as
 * guidance. Quitting is the deliberate "leave the rest for later" choice.
 */
async function offerCloseFollowUpsTui(tui: CloseTui, followUps: FollowUpOffers): Promise<void> {
  const mainDir = (await mainWorktreeDir(followUps.targetDir).catch(() => undefined)) ?? followUps.targetDir
  const state: CloseInteractiveFollowUpState = {}
  const view = () => buildCloseFollowUpsView({ followUps, state })

  for (;;) {
    const resolution = await tui.selectFollowUp(await view())
    if (resolution.type === "done") return
    const id = resolution.id
    state[id] = { status: "running" }
    tui.updateFollowUps(await view())
    try {
      if (id === "push") {
        if (!followUps.push) continue
        await tui.withTerminal(() => pushRefspec(followUps.push!.remote, followUps.push!.refspec, mainDir))
      } else if (id === "worktree") {
        if (!followUps.worktreeRemoval) continue
        // A resolved feature runs the feature-keyed guarded operation — the
        // same identity-aware checks the printed command executes (design
        // D9); the legacy direct removal remains only for synthetic offers
        // without one.
        if (followUps.featureId) await runCloseCleanup({ targetDir: followUps.targetDir, featureId: followUps.featureId, cleanup: "worktree" })
        else await removeWorktree(followUps.worktreeDir, mainDir)
      } else {
        // Evidence is rechecked at action time (task 7.6), then the guarded
        // expected-tip deletion runs: the squash landing left no merge
        // ancestry, so the receipt is the authority, and the atomic
        // update-ref -d makes the tip check and the deletion one operation.
        if (followUps.featureId) await runCloseCleanup({ targetDir: followUps.targetDir, featureId: followUps.featureId, cleanup: "branch" })
        else await guardedBranchDeletion(mainDir, followUps)
      }
      state[id] = { status: "completed" }
    } catch (error) {
      state[id] = { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Cleanup follows git's dependency graph (design D7): push is independent;
 * worktree removal must succeed before branch deletion is offered. Every
 * action is a deliberate choice, a failure keeps the action available for
 * retry, and nothing runs without an explicit yes.
 */
export async function offerCloseFollowUps(followUps: FollowUpOffers, io: CloseIO = {}): Promise<void> {
  const out = io.output ?? stdout
  out.write("\n")
  const mainDir = (await mainWorktreeDir(followUps.targetDir).catch(() => undefined)) ?? followUps.targetDir

  if (followUps.push) {
    const accepted = await offerAction(
      "push",
      `Push ${followUps.baseRef} to ${followUps.push.remote} (${followUps.push.refspec})? [y/N] `,
      () => pushRefspec(followUps.push!.remote, followUps.push!.refspec, mainDir),
      io,
    )
    if (!accepted) out.write(`next: ${followUps.push.command}\n`)
  } else if (followUps.pushRemediation) {
    out.write(`push unavailable — ${followUps.pushRemediation}\n`)
  }

  let worktreeRemoved = false
  if (followUps.worktreeRemoval) {
    if (processCwdInside(followUps.worktreeDir)) {
      out.write(`to remove the worktree once you're out of it: ${followUps.worktreeRemoval}\n`)
    } else {
      worktreeRemoved = await offerAction(
        "worktree removal",
        `Remove the worktree at ${followUps.worktreeDir}? [y/N] `,
        async () => {
          if (followUps.featureId) await runCloseCleanup({ targetDir: followUps.targetDir, featureId: followUps.featureId, cleanup: "worktree" })
          else await removeWorktree(followUps.worktreeDir, mainDir)
        },
        io,
      )
      if (worktreeRemoved) out.write("worktree removed\n")
      else out.write(`next: ${followUps.worktreeRemoval}\n`)
    }
  }

  // git refuses to delete a branch that is checked out in a worktree, so the
  // offer only exists once that dependency cleared. The worktree may be gone
  // already (removed between runs or by hand) — then the branch is deletable
  // now and the immediate command is printed, not a wait (SC-9).
  const worktreeStillExists = await stat(followUps.worktreeDir).then(
    () => true,
    () => false,
  )
  // The deletion offer is evidence-gated at print time and rechecked at
  // action time (design D7); without a receipt the guarded command is the
  // only thing shown, and when no command exists the remediation is.
  if (worktreeRemoved) {
    const deleted = await offerAction(
      "branch deletion",
      `Delete the branch ${followUps.branch}? [y/N] `,
      async () => {
        if (followUps.featureId) await runCloseCleanup({ targetDir: followUps.targetDir, featureId: followUps.featureId, cleanup: "branch" })
        else await guardedBranchDeletion(mainDir, followUps)
      },
      io,
    )
    if (deleted) out.write(`branch ${followUps.branch} deleted\n`)
    else out.write(`next: ${followUps.branchDelete ?? followUps.branchDeleteRemediation}\n`)
  } else if (!worktreeStillExists && !processCwdInside(followUps.worktreeDir)) {
    out.write(`next: ${followUps.branchDelete ?? followUps.branchDeleteRemediation}\n`)
  } else if (worktreeStillExists && !processCwdInside(followUps.worktreeDir)) {
    out.write(`next (after the worktree is removed): ${followUps.branchDelete ?? followUps.branchDeleteRemediation}\n`)
  }
}

/** One deliberate action with retry: a failure keeps the offer alive; N prints the command instead. */
async function offerAction(label: string, question: string, action: () => Promise<void>, io: CloseIO): Promise<boolean> {
  for (;;) {
    if ((await ask(question, io)) !== "y") return false
    try {
      await action()
      return true
    } catch (error) {
      log.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)} — answer y to retry, N to skip`)
    }
  }
}

/** Removing the directory the process sits in leaves the shell nowhere; print the command instead. */
function processCwdInside(dir: string): boolean {
  const cwd = resolve(process.cwd())
  const target = resolve(dir)
  return cwd === target || cwd.startsWith(`${target}/`)
}

// The single-key `ask` confirmation and the interactive-terminal check live in
// `terminal-input.ts`, shared with `finish` so their SIGINT/EOF semantics stay
// identical (SC-3).

// ---------------------------------------------------------------------------

/** Archive-on-main for probably-merged changes, routed from the board. */
export async function runArchiveOnMain(input: { targetDir: string; changeID: string }): Promise<void> {
  try {
    const result = await archiveChangeOnMain(input)
    stdout.write(
      result.committed
        ? `archived ${input.changeID} in the main checkout and committed on the base branch${result.archiveSource ? ` (archive source: ${result.archiveSource})` : ""}\n`
        : `openspec archived ${input.changeID} with nothing to commit${result.archiveSource ? ` (archive source: ${result.archiveSource})` : ""}\n`,
    )
    stdout.write("integration remains probably merged or pending — archive-on-main never claims the feature landed\n")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    process.exitCode = 1
  }
}

export function closeHelp(): string {
  return `convoy close

Close a feature in one resumable sequence: preflight, sync the base branch
into the feature branch, archive the change through the OpenSpec CLI, then
squash-merge the whole feature as exactly one regular conventional commit on
the base branch (your identity, your signature). The feature branch's history
is never rewritten — every author's work reaches the base as content of the
one landing commit, and the landing is a guarded fast-forward-only update of
the base ref that refuses if the base moved.

In a terminal the sequence renders in a full-screen TUI — each step's
completion, skip (with reason), or failure visible as it happens, and the
base plus landing commit named. The squash-merge row names its sub-phase as
it works: composing the commit message, waiting for your review, creating
the one-parent landing commit — and the running indicator keeps animating
while the writer answers. The landing commit's message is composed from the
change's proposal and touched capabilities, with a deterministic fallback
when no model answers; the scope is always the single touched capability,
and the change id is named in the body.

The review screen is a vertical Accept / Edit / Cancel list: up/down (or j/k)
moves the selection, Enter activates it, and the y/e/n shortcuts still work.
Edit opens an inline multiline editor inside the TUI — Enter inserts a
newline, Ctrl+S saves and returns to review, Esc discards the draft and keeps
the previously reviewed message. Nothing lands until you explicitly accept,
so saving an edit is not a confirmation.

Once landed, current-session cleanup stays in that TUI as separate, deliberate
actions — never automatic. Push is a normal push that names the configured
remote and refspec explicitly, and is unavailable (with the setup step) when
the base branch has no upstream. Cleanup — worktree removal, then branch
deletion — is evidence-gated and feature-keyed: the printed and deferred
commands are \`convoy close --feature <id> --cleanup worktree|branch\`, which
revalidate the association, the verified landing receipt (exact tip and a
landing commit still reachable from the base), the worktree inventory, live
runs, and the mutation lease at execution time before the guarded removal or
the atomic expected-tip ref deletion runs. When close was
launched from inside the feature worktree, worktree and branch cleanup are
shown instead as deferred cleanup — the reason (a process cannot remove the
directory its shell sits in) plus those same feature-keyed commands to run
after leaving the worktree. Headless (piped) runs print the same facts as a
stdout summary plus the same executable commands, and attempt nothing
interactive.

The feature is resolved through stable identity: running inside the worktree
or passing --branch <name> still selects it, but an unassociated context
refuses until the work is adopted explicitly (\`convoy feature adopt\`), and
--feature <id> resolves, resumes, and cleans up by identity — including after
the worktree was removed.

Usage:
  convoy close [--branch <name>] [--change <id>] [--feature <id>] [--resume]
               [--cleanup worktree|branch] [--message <subject>]

Options:
  --branch <name>    Close the feature worktree carrying this branch
  --change <id>      Pin the OpenSpec change id (default: the branch's id)
  --feature <id>     Resolve by stable feature id (see \`convoy feature show\`);
                     permits resume and cleanup after the worktree is gone
  --cleanup <what>   Cleanup-only continuation of a verified landing:
                     \`worktree\` removes the feature worktree, \`branch\` then
                     deletes the local branch at its landed tip (expected-tip
                     guarded; requires --feature). Requires --feature.
  --resume           Continue a stopped sequence from the first incomplete step
  --message <text>   Exact message for the squashed commit; skips composition
                     and confirmation
  --dry-run          Print the sequence without touching anything
`
}

export function parseCloseArgs(argv: string[]): CloseOptions {
  const options: CloseOptions = { targetDir: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const next = argv[++i]
      if (!next || next.startsWith("-")) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === "--branch") options.branch = value()
    else if (arg.startsWith("--branch=")) options.branch = arg.slice("--branch=".length)
    else if (arg === "--change") options.changeID = value()
    else if (arg.startsWith("--change=")) options.changeID = arg.slice("--change=".length)
    else if (arg === "--feature") options.featureId = value()
    else if (arg.startsWith("--feature=")) options.featureId = arg.slice("--feature=".length)
    else if (arg === "--cleanup") {
      const what = value()
      if (what !== "worktree" && what !== "branch") {
        throw new Error(`--cleanup expects "worktree" or "branch", got "${what}"`)
      }
      options.cleanup = what
    } else if (arg.startsWith("--cleanup=")) {
      const what = arg.slice("--cleanup=".length)
      if (what !== "worktree" && what !== "branch") {
        throw new Error(`--cleanup expects "worktree" or "branch", got "${what}"`)
      }
      options.cleanup = what
    } else if (arg === "--message") options.message = value()
    else if (arg.startsWith("--message=")) options.message = arg.slice("--message=".length)
    else if (arg === "--resume") options.resume = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--worktree-dir") options.worktreeDir = value()
    else throw new Error(`usage: convoy close [--branch <name>] [--change <id>] [--feature <id>] [--resume] [--cleanup worktree|branch] [--message <subject>] (unexpected argument: ${arg})`)
  }
  return options
}

// -- shared helpers -------------------------------------------------------------

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? value
}

/** The display/commit boundary sanitizer for model- and git-derived text (SC-4). */
function strip(value: string | undefined): string {
  return stripControlBytes(value ?? "")
}

/** Quotes a token for the shell only when it would otherwise break out of a bare word. */
function shq(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

async function sameDir(a: string, b: string): Promise<boolean | undefined> {
  const aExists = await stat(a).then(
    () => true,
    () => false,
  )
  const bExists = await stat(b).then(
    () => true,
    () => false,
  )
  if (!aExists || !bExists) return undefined
  const { realpath } = await import("node:fs/promises")
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return a === b
  }
}
