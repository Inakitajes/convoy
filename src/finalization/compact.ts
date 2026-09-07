import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { formatCommitMessage, proposeCommitMessage } from "../commit-message"
import { currentHead, diffStat, execFile, resetSoft, resolveCommit } from "../git"
import { readPersistedRunTitle } from "../run-title"
import { convoyHome } from "../workspace"
import type { FeaturePlanLink } from "../types"
import { boundedCommitAsOperator } from "./executor"
import { verifyRunInterval, type RunInterval } from "./interval"
import { acquireMutationLease, LeaseUnavailableError, type MutationLease } from "./lease"
import { createRefIfAbsent, gitCommonDir, ledgerTipRef, preCompactionRef } from "./refs"
import { verifyNotPublished } from "./remote"
import type { CommitLedgerEntry, FinalizationRecord, RecoveryManifest, RunBoundary } from "./types"

/**
 * The guarded automatic compaction transaction (design D2/D4, tasks 2.6–2.7):
 * after successful execution, goal settlement, and success hooks, the verified
 * current-run commit interval is collapsed into one operator-authored
 * conventional commit — unattended, without message confirmation, and without
 * publishing anything.
 *
 * Safety shape, in order:
 * 1. reconcile any journal left by a stopped attempt (never duplicate or discard);
 * 2. re-verify branch identity, HEAD, and a clean tree immediately before mutating;
 * 3. verify the interval from the durable boundary + ledger (never authorship);
 * 4. acquire the repository mutation lease;
 * 5. verify remote publication state (bounded, read-only);
 * 6. persist recovery evidence (create-only refs, manifest, run index) — a
 *    failure here blocks the rewrite;
 * 7. journal the expected transaction state, then soft-reset, verify the
 *    staged tree, and commit via the bounded non-interactive executor;
 * 8. on any failure restore the original HEAD when the checkout still matches
 *    operation-owned state, otherwise preserve evidence and mark recovery required.
 *
 * A safely blocked or failed compaction never turns pipeline execution into a
 * failure: the outcome is returned as a record the caller persists separately.
 */

export const finalizationJournalSchemaVersion = 1

/** The durable transaction journal, stored in the repository's Git common dir. */
export type FinalizationJournal = {
  schemaVersion: number
  runID: string
  branch?: string
  originalHead: string
  startHead: string
  headTree: string
  phase: "prepared" | "committed"
  producedSha?: string
  updatedAt: number
}

export type FinalizationProgress = {
  activity?(detail: string, kind?: "info" | "error"): void
}

export type RunFinalizationInput = {
  runID: string
  /** The worktree the run executed in. */
  targetDir: string
  /** The run workspace dir, when it still exists; message composition reads its SUMMARY.md/prd.md. */
  runDir?: string
  boundary: RunBoundary | undefined
  ledger: readonly CommitLedgerEntry[]
  /** Frozen pipeline name/branch context for message composition. */
  branch?: string
  /** The reviewed feature link, preserved in the cleanup-surviving index (task 5.1). */
  feature?: FeaturePlanLink
  commitMessageModel?: string
  signal?: AbortSignal
  progress?: FinalizationProgress
  /**
   * Overrides message composition (hermetic tests inject a deterministic
   * composer instead of the model-backed writer).
   */
  composeMessage?: (interval: Extract<RunInterval, { ok: true }>) => Promise<string>
}

/**
 * Runs one finalization attempt. Always resolves with a record; throwing is
 * reserved for programmer errors, since a safety refusal is itself a result.
 */
export async function runFinalization(input: RunFinalizationInput): Promise<FinalizationRecord> {
  const cwd = input.targetDir
  const now = () => Date.now()
  const activity = (detail: string, kind: "info" | "error" = "info") => input.progress?.activity?.(detail, kind)

  const commonDir = (await gitCommonDir(cwd)) ?? ""
  const journalPath = commonDir ? join(commonDir, "convoy", "finalization", `${input.runID}.json`) : ""

  // 1. Reconcile a stopped attempt before anything else.
  if (journalPath) {
    const reconciled = await reconcileJournal(journalPath, input.runID, cwd)
    if (!reconciled.ok) {
      return record("blocked", reconciled.reason, { recoveryRequired: true, now })
    }
    if (reconciled.alreadyCompleted) {
      return record("completed", reconciled.reason, {
        now,
        producedSha: reconciled.producedSha,
        manifestPath: journalPath,
      })
    }
  }

  // 2–3. Guards and interval verification.
  const interval = await verifyRunInterval(input.boundary, input.ledger, input.runID, cwd)
  if (!interval.ok) {
    if (interval.kind === "no-boundary" || interval.kind === "missing-head") {
      // Legacy runs and commit-less runs skip without touching anything.
      return record("skipped", interval.reason, { now })
    }
    return record("blocked", interval.reason, { now })
  }
  if (interval.commits.length === 0) {
    return record("skipped", "the run created no commits; nothing to compact", { now })
  }
  // A verified interval whose final tree equals the run-start tree produced no
  // net content: remove the interval instead of manufacturing an empty commit.
  if (isNetZeroInterval(interval)) {
    return await finalizeNetZeroInterval(input, interval)
  }

  let lease: MutationLease | undefined
  try {
    // 4. Serialize against other Convoy mutations in this repository.
    if (commonDir) lease = await acquireMutationLease(commonDir)
  } catch (error) {
    const reason = error instanceof LeaseUnavailableError ? error.message : `couldn't acquire the repository mutation lease: ${String(error)}`
    return record("blocked", reason, { now })
  }

  try {
    // 5. Publication safety: never replace commits a remote branch advertises.
    const publication = await verifyNotPublished(interval.commits.map((commit) => commit.sha), cwd)
    if (!publication.ok) {
      return record("blocked", `${publication.reason}. Feature close can still squash-land the whole feature.`, { now })
    }

    // 6. Recovery evidence must be durable before any rewrite begins.
    const evidence = await protectEvidence(input, interval, commonDir, "compacted")
    if (!evidence.ok) {
      return record("blocked", `recovery evidence could not be saved; no history was rewritten (${evidence.reason})`, { now })
    }

    // Compose the conventional message (bounded, deterministic fallback).
    const message = input.composeMessage ? await input.composeMessage(interval) : await composeMessage(input, interval)

    // 7. Journal, then the guarded rewrite.
    if (journalPath) {
      await writeJournal(journalPath, {
        schemaVersion: finalizationJournalSchemaVersion,
        runID: input.runID,
        ...(input.branch ? { branch: input.branch } : {}),
        originalHead: interval.headSha,
        startHead: interval.startHead,
        headTree: interval.headTree,
        phase: "prepared",
        updatedAt: now(),
      })
    }

    await resetSoft(interval.startHead, cwd)
    activity("collapsed run commits into the index")

    // The staged tree must be exactly the pre-reset HEAD tree: the reset only
    // moved the branch pointer, so any mismatch means someone else touched the
    // index and the operation must stop before committing.
    const stagedTree = await indexTree(cwd)
    if (stagedTree !== interval.headTree) {
      await restoreOriginalHead(interval.headSha, cwd)
      return record("failed", "the index changed during compaction; the original branch state was restored", { now })
    }

    let produced: string
    try {
      const result = await boundedCommitAsOperator(message, cwd)
      produced = result.sha
    } catch (error) {
      // Restore only when the checkout still matches operation-owned state.
      const head = await currentHead(cwd)
      const staged = await indexTree(cwd)
      if (head === interval.startHead && staged === interval.headTree) {
        await resetSoft(interval.headSha, cwd)
        const reason = error instanceof Error ? error.message : String(error)
        return record("failed", `the squashed commit could not be created; the branch was restored unchanged (${reason})`, { now })
      }
      return record("failed", `the squashed commit failed and the worktree no longer matches the transaction; recovery required (${String(error)})`, {
        now,
        recoveryRequired: true,
      })
    }

    // Verify the produced commit before declaring completion.
    const producedParent = await parentOf(produced, cwd)
    const producedTree = await treeOfCommit(produced, cwd)
    if (producedParent !== interval.startHead || producedTree !== interval.headTree) {
      return record("failed", `the produced commit does not match the prepared transaction (parent ${producedParent?.slice(0, 8)}, tree ${producedTree?.slice(0, 8)}); recovery required`, {
        now,
        recoveryRequired: true,
      })
    }

    if (journalPath) {
      await writeJournal(journalPath, {
        schemaVersion: finalizationJournalSchemaVersion,
        runID: input.runID,
        ...(input.branch ? { branch: input.branch } : {}),
        originalHead: interval.headSha,
        startHead: interval.startHead,
        headTree: interval.headTree,
        phase: "committed",
        producedSha: produced,
        updatedAt: now(),
      })
    }

    // Persist the outcome in the cleanup-surviving run index.
    await updateRunIndex(input, interval, produced, evidence.manifestPath, evidence.preCompactionRef, "compacted")

    activity(`compacted ${interval.commits.length} run commit${interval.commits.length === 1 ? "" : "s"} into ${produced.slice(0, 8)}`)
    return record("completed", undefined, {
      now,
      producedSha: produced,
      producedMessage: message,
      recoveryRef: evidence.preCompactionRef,
      manifestPath: evidence.manifestPath,
    })
  } finally {
    await lease?.release()
  }
}

/**
 * Removes a verified net-zero current-run interval (design D2): the run's
 * commits net out to the boundary tree, so the branch returns to the
 * run-start HEAD without manufacturing an empty commit. Evidence is protected
 * exactly as for a real compaction, and the outcome records
 * `completed` with a no-net-change disposition.
 */
export async function finalizeNetZeroInterval(input: RunFinalizationInput, interval: Extract<RunInterval, { ok: true }>): Promise<FinalizationRecord> {
  const cwd = input.targetDir
  const now = () => Date.now()
  const commonDir = (await gitCommonDir(cwd)) ?? ""

  let lease: MutationLease | undefined
  try {
    if (commonDir) lease = await acquireMutationLease(commonDir)
  } catch (error) {
    return record("blocked", error instanceof LeaseUnavailableError ? error.message : String(error), { now })
  }

  try {
    const publication = await verifyNotPublished(interval.commits.map((commit) => commit.sha), cwd)
    if (!publication.ok) {
      return record("blocked", `${publication.reason}. No history was changed.`, { now })
    }

    const evidence = await protectEvidence(input, interval, commonDir, "no-net-change")
    if (!evidence.ok) {
      return record("blocked", `recovery evidence could not be saved; no history was rewritten (${evidence.reason})`, { now })
    }

    // Guarded ref update back to the boundary: expected-old-value semantics
    // make a concurrent branch movement refuse instead of clobber.
    try {
      await execFile("git", ["update-ref", `refs/heads/${input.branch ?? (await currentBranchOrThrow(cwd))}`, interval.startHead, interval.headSha], { cwd })
    } catch (error) {
      return record("blocked", `the branch moved during finalization; no history was changed (${String(error)})`, { now })
    }
    // The trees are identical, so the hard reset below only clears residual
    // staged state from the removed commits. If the index changed since the
    // interval check — a concurrent staged edit landing during the potentially
    // long publication probe above — restore the branch pointer and refuse
    // rather than hard-reset work Convoy does not own (design D4).
    const stagedBeforeReset = await indexTree(cwd)
    if (stagedBeforeReset !== interval.headTree) {
      await execFile("git", ["reset", "--soft", interval.headSha], { cwd }).catch(() => {})
      return record("blocked", "the index changed during finalization; the branch was restored and no history was rewritten", { now })
    }
    // Align index/worktree with the restored branch (trees are identical, so
    // this only cleans any residual staged state from the removed commits).
    await execFile("git", ["reset", "--hard", interval.startHead], { cwd })

    await updateRunIndex(input, interval, undefined, evidence.manifestPath, evidence.preCompactionRef, "no-net-change")
    return record("completed", "the run's commits net out to no content change; the interval was removed back to the run start", {
      now,
      recoveryRef: evidence.preCompactionRef,
      manifestPath: evidence.manifestPath,
    })
  } finally {
    await lease?.release()
  }
}

// --- Internals --------------------------------------------------------------

type EvidenceResult = { ok: true; preCompactionRef: string; manifestPath: string } | { ok: false; reason: string }

/** Protects the pre-compaction tip, every ledgered commit tip, and writes the recovery manifest + run index. */
async function protectEvidence(
  input: RunFinalizationInput,
  interval: Extract<RunInterval, { ok: true }>,
  commonDir: string,
  disposition: RecoveryManifest["disposition"],
): Promise<EvidenceResult> {
  const cwd = input.targetDir
  const preRef = preCompactionRef(input.runID)
  try {
    await createRefIfAbsent(preRef, interval.headSha, cwd)
  } catch (error) {
    return { ok: false, reason: `couldn't protect the pre-compaction tip: ${String(error)}` }
  }

  const protectedRefs = [preRef]
  for (const [index, commit] of interval.commits.entries()) {
    const ref = ledgerTipRef(input.runID, index)
    try {
      await createRefIfAbsent(ref, commit.sha, cwd)
      protectedRefs.push(ref)
    } catch (error) {
      return { ok: false, reason: `couldn't protect commit tip ${commit.sha.slice(0, 8)}: ${String(error)}` }
    }
  }

  if (!commonDir) return { ok: false, reason: "the repository's git common dir could not be resolved" }

  const manifest: RecoveryManifest = {
    schemaVersion: 1,
    runID: input.runID,
    commonDir,
    worktreeDir: input.boundary?.worktreeDir ?? input.targetDir,
    ...(input.branch ? { branch: input.branch } : {}),
    startHead: interval.startHead,
    preCompactionHead: interval.headSha,
    replacedCommits: interval.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject, step: commit.step, mode: commit.mode })),
    protectedRefs,
    disposition,
    recordedAt: Date.now(),
  }
  const manifestPath = join(commonDir, "convoy", "finalization", `${input.runID}.manifest.json`)
  try {
    await mkdir(dirname(manifestPath), { recursive: true })
    await atomicWriteJson(manifestPath, manifest)
  } catch (error) {
    return { ok: false, reason: `couldn't write the recovery manifest: ${String(error)}` }
  }

  return { ok: true, preCompactionRef: preRef, manifestPath }
}

async function updateRunIndex(
  input: RunFinalizationInput,
  interval: Extract<RunInterval, { ok: true }>,
  producedSha: string | undefined,
  manifestPath: string,
  recoveryRef: string,
  disposition: "compacted" | "no-net-change",
): Promise<void> {
  try {
    const dir = join(convoyHome(), "run-records")
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${input.runID}.json`)
    const now = Date.now()
    let entry: Record<string, unknown> | undefined
    try {
      entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {
      entry = undefined
    }
    const body = {
      ...(entry ?? {}),
      schemaVersion: 1,
      runID: input.runID,
      commonDir: (await gitCommonDir(input.targetDir)) ?? "",
      worktreeDir: input.targetDir,
      ...(input.branch ? { branch: input.branch } : {}),
      // The reviewed feature link survives workspace cleanup (task 5.1): run
      // history joins by identity, never by reinterpreting a stored path.
      ...(input.feature ? { feature: input.feature } : {}),
      manifestPath,
      recoveryRef,
      preCompactionHead: interval.headSha,
      startHead: interval.startHead,
      ...(producedSha ? { producedSha } : {}),
      disposition,
      state: "completed" as const,
      // The run's persisted title survives workspace cleanup so run discovery
      // can still name the run it rediscovers through this index. Priority:
      // the metadata's stored title, then an earlier index title (a legacy
      // record named once must not be renamed again by a prd rewrite), then
      // the prd.md fallback. The record keeps the exact untruncated value —
      // display truncation is the runs list's concern, not the durable
      // evidence's.
      title:
        (await readPersistedRunTitle(input.runDir)) ??
        (entry?.title as string | undefined) ??
        (await promptTitleFrom(input.runDir)),
      recordedAt: (entry?.recordedAt as number | undefined) ?? now,
      updatedAt: now,
    }
    await atomicWriteJson(path, body)
  } catch {
    // The index is discoverability sugar over the manifest and refs; a failed
    // write must not fail the compaction itself.
  }
}

/**
 * The legacy prd.md first-line fallback for a run's title; used only when
 * neither the metadata nor the existing index record carries one. `undefined`
 * when unavailable.
 */
async function promptTitleFrom(runDir: string | undefined): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  const prd = await readOptional(join(runDir, "prd.md"))
  if (!prd) return undefined
  const line = prd.split("\n").map((raw) => raw.replace(/^#+\s*/, "").trim()).find(Boolean)
  return line || undefined
}

type ReconcileResult =
  | { ok: true; alreadyCompleted: false }
  | { ok: true; alreadyCompleted: true; producedSha?: string; reason: string }
  | { ok: false; reason: string }

/**
 * Reconciles a journal left by a stopped attempt (design D4, task 2.6):
 * recognized states complete the outcome without re-squashing; ambiguous
 * states refuse with recovery required and never discard work.
 */
async function reconcileJournal(journalPath: string, runID: string, cwd: string): Promise<ReconcileResult> {
  let journal: FinalizationJournal
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as FinalizationJournal
  } catch {
    return { ok: true, alreadyCompleted: false }
  }
  if (journal.schemaVersion !== finalizationJournalSchemaVersion || journal.runID !== runID) return { ok: true, alreadyCompleted: false }

  const head = await currentHead(cwd)
  if (journal.phase === "committed" && journal.producedSha) {
    const produced = await resolveCommit(journal.producedSha, cwd)
    if (produced && head === produced) {
      return { ok: true, alreadyCompleted: true, producedSha: produced, reason: "a previous attempt already created this compaction commit" }
    }
    return {
      ok: false,
      reason: `a previous finalization attempt recorded commit ${journal.producedSha.slice(0, 8)} but the branch tip is ${head?.slice(0, 8) ?? "unknown"}; inspect the run's protected refs before continuing`,
    }
  }

  // phase "prepared": the soft reset happened (or did not) but no commit landed.
  if (head === journal.originalHead) {
    await rmForce(journalPath)
    return { ok: true, alreadyCompleted: false }
  }
  if (head === journal.startHead) {
    const staged = await indexTree(cwd)
    if (staged === journal.headTree) {
      // Exactly the prepared state: restore the branch pointer and let a fresh
      // attempt redo the transaction from the top.
      await resetSoft(journal.originalHead, cwd)
      await rmForce(journalPath)
      return { ok: true, alreadyCompleted: false }
    }
  }
  return {
    ok: false,
    reason: `a previous finalization attempt stopped in an unrecognized state (HEAD ${head?.slice(0, 8) ?? "unknown"}); inspect the repository before continuing`,
  }
}

async function composeMessage(input: RunFinalizationInput, interval: Extract<RunInterval, { ok: true }>): Promise<string> {
  const summary = await readOptional(join(input.runDir ?? "", "SUMMARY.md"))
  const prompt = await readOptional(join(input.runDir ?? "", "prd.md"))
  const stat = await diffStat(interval.startHead, interval.headSha, input.targetDir)
  const proposal = await proposeCommitMessage({
    targetDir: input.targetDir,
    branch: input.branch ?? (await currentBranchOrThrow(input.targetDir)),
    commits: interval.commits.map((commit) => commit.subject).reverse(),
    diffStat: stat,
    ...(summary ? { summary } : {}),
    ...(prompt ? { prompt } : {}),
    ...(input.commitMessageModel ? { model: input.commitMessageModel } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const message = proposal.message
  return formatCommitMessage(message)
}

async function restoreOriginalHead(originalHead: string, cwd: string): Promise<void> {
  await resetSoft(originalHead, cwd).catch(() => {})
}

async function indexTree(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["write-tree"], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function parentOf(sha: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${sha}^`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function treeOfCommit(sha: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function currentBranchOrThrow(cwd: string): Promise<string> {
  const result = await execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error("HEAD is detached")
  return result.stdout.trim()
}

async function readOptional(path: string): Promise<string | undefined> {
  if (!path || path === "/") return undefined
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

async function writeJournal(path: string, journal: FinalizationJournal): Promise<void> {
  await atomicWriteJson(path, journal)
}

async function rmForce(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {})
}

function record(
  state: FinalizationRecord["state"],
  reason: string | undefined,
  options: {
    now: () => number
    producedSha?: string
    producedMessage?: string
    recoveryRef?: string
    manifestPath?: string
    recoveryRequired?: boolean
  },
): FinalizationRecord {
  return {
    schemaVersion: 1,
    state,
    ...(reason ? { reason } : {}),
    ...(options.producedSha ? { producedSha: options.producedSha } : {}),
    ...(options.producedMessage ? { producedMessage: options.producedMessage } : {}),
    ...(options.recoveryRef ? { recoveryRef: options.recoveryRef } : {}),
    ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}),
    ...(options.recoveryRequired ? { recoveryRequired: true } : {}),
    updatedAt: options.now(),
  }
}

// Net-zero detection for callers bridging verifyRunInterval to the net-zero path.
export function isNetZeroInterval(interval: Extract<RunInterval, { ok: true }>): boolean {
  return interval.startTree === interval.headTree && interval.commits.length > 0
}
