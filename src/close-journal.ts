import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { execFile, isAncestor, resolveCommit } from "./git"
import { createRefIfAbsent, gitCommonDir, refExists } from "./finalization/refs"

/** One delta-spec requirement effect the archive must verify (shared with the archive verifier). */
export type RequiredEffect = {
  kind: "present" | "absent"
  capability: string
  name: string
  scenarios: string[]
}


/**
 * The close journal and landing receipt (capability feature-close, design D6
 * and D7, tasks 5.1/5.5/5.7): a versioned record in the repository's Git
 * common dir, keyed by feature branch and change id, that stages a true
 * squash-merge landing transaction and survives worktree removal.
 *
 * A receipt (`phase: "landed"`) is the evidence-gating record for cleanup: it
 * names the exact feature tip and landing commit, so worktree removal and
 * `branch -D` can be authorized against verified identity rather than tree
 * equality or ancestry guesses. A squash landing leaves no merge ancestry, so
 * without this record nothing safe can be inferred.
 */

export const closeJournalSchemaVersion = 1

/** The transaction phases a close journal moves through. */
export type CloseJournalPhase = "prepared" | "candidate" | "landed"

export type CloseJournal = {
  schemaVersion: number
  /** A new attempt (fresh sync/arc/review) replaces this id; stale candidates are never reused silently. */
  attemptID: string
  /** The feature branch and change this journal belongs to. */
  branch: string
  changeID: string
  /** The base branch name and the exact base commit the sequence captured. */
  baseRef: string
  baseSha: string
  /** The feature tip before sync (undefined when sync was a detected skip). */
  preSyncTip?: string
  /** The feature tip after sync + archive; the squash-merge source. */
  postArchiveTip?: string
  /** The prepared tree: the candidate commit must carry exactly this tree. */
  preparedTree?: string
  /** The message inputs snapshot, preserved before archive for resume (design D6). */
  messageContext?: {
    proposalExcerpt?: string
    scopeCandidates: string[]
    commitSubjects: string[]
  }
  /** The reviewed/confirmed message, kept so a crash after candidate creation can reland it verbatim. */
  message?: string
  /** The one-parent candidate commit created on the captured base. */
  candidateSha?: string
  /** The base branch after the guarded landing. */
  landingSha?: string
  /**
   * The canonical effects the archive must prove, snapshotted from the
   * change's own deltas BEFORE the archive mutation (task 7.2). Resume
   * validates against this snapshot — an operator editing or deleting the
   * archived copy's deltas after the fact cannot make verification vacuous.
   * Absent on journals written before this field existed.
   */
  requiredEffects?: RequiredEffect[]
  /**
   * Whether the base checkout has been materialized onto the landed ref
   * (task 7.5): the guarded ref transaction is the landing; the checkout
   * update is a distinct recorded stage. `false` means the landing stands
   * but the checkout still needs reconciliation before cleanup.
   */
  checkoutMaterialized?: boolean
  phase: CloseJournalPhase
  recordedAt: number
  updatedAt: number
}

/** Path-encoding for the journal filename: branch names are bounded, but be safe anyway. */
export function journalSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_")
}

function journalPath(commonDir: string, branch: string, changeID: string): string {
  return join(commonDir, "convoy", "close", `${journalSlug(branch)}__${journalSlug(changeID)}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

const phases: readonly CloseJournalPhase[] = ["prepared", "candidate", "landed"]

/** Backward-compatible reader: garbage or foreign shapes yield undefined, never throw. */
export function readCloseJournalValue(value: unknown): CloseJournal | undefined {
  if (!isRecord(value)) return undefined
  // Journals are new-format only; a foreign version's unknown semantics are
  // never silently interpreted as the current shape (design D7).
  if (value.schemaVersion !== closeJournalSchemaVersion) return undefined
  const branch = optionalString(value.branch)
  const changeID = optionalString(value.changeID)
  const baseRef = optionalString(value.baseRef)
  const baseSha = optionalString(value.baseSha)
  const phase = value.phase
  if (!branch || !changeID || !baseRef || !baseSha) return undefined
  if (typeof phase !== "string" || !phases.includes(phase as CloseJournalPhase)) return undefined
  const messageContext = isRecord(value.messageContext)
    ? {
        ...(optionalString(value.messageContext.proposalExcerpt) ? { proposalExcerpt: optionalString(value.messageContext.proposalExcerpt) } : {}),
        scopeCandidates: Array.isArray(value.messageContext.scopeCandidates)
          ? value.messageContext.scopeCandidates.filter((entry): entry is string => typeof entry === "string")
          : [],
        commitSubjects: Array.isArray(value.messageContext.commitSubjects)
          ? value.messageContext.commitSubjects.filter((entry): entry is string => typeof entry === "string")
          : [],
      }
    : undefined
  let requiredEffects: RequiredEffect[] | undefined
  if (value.requiredEffects !== undefined) {
    if (!Array.isArray(value.requiredEffects)) return undefined
    requiredEffects = []
    for (const effect of value.requiredEffects) {
      if (!isRecord(effect)) return undefined
      if ((effect.kind !== "present" && effect.kind !== "absent") || typeof effect.capability !== "string" || typeof effect.name !== "string") return undefined
      requiredEffects.push({
        kind: effect.kind,
        capability: effect.capability,
        name: effect.name,
        scenarios: Array.isArray(effect.scenarios) ? effect.scenarios.filter((scenario): scenario is string => typeof scenario === "string") : [],
      })
    }
  }
  return {
    schemaVersion: closeJournalSchemaVersion,
    attemptID: optionalString(value.attemptID) ?? "",
    branch,
    changeID,
    baseRef,
    baseSha,
    ...(optionalString(value.preSyncTip) ? { preSyncTip: optionalString(value.preSyncTip) } : {}),
    ...(optionalString(value.postArchiveTip) ? { postArchiveTip: optionalString(value.postArchiveTip) } : {}),
    ...(optionalString(value.preparedTree) ? { preparedTree: optionalString(value.preparedTree) } : {}),
    ...(messageContext ? { messageContext } : {}),
    ...(optionalString(value.message) ? { message: optionalString(value.message) } : {}),
    ...(optionalString(value.candidateSha) ? { candidateSha: optionalString(value.candidateSha) } : {}),
    ...(optionalString(value.landingSha) ? { landingSha: optionalString(value.landingSha) } : {}),
    ...(requiredEffects ? { requiredEffects } : {}),
    ...(typeof value.checkoutMaterialized === "boolean" ? { checkoutMaterialized: value.checkoutMaterialized } : {}),
    phase: phase as CloseJournalPhase,
    recordedAt: typeof value.recordedAt === "number" ? value.recordedAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

/** Reads the journal for a branch/change; undefined when none exists or it cannot be parsed. */
export async function readCloseJournal(commonDir: string, branch: string, changeID: string): Promise<CloseJournal | undefined> {
  try {
    const raw = await readFile(journalPath(commonDir, branch, changeID), "utf8")
    const parsed: unknown = JSON.parse(raw)
    const journal = readCloseJournalValue(parsed)
    return journal && journal.schemaVersion === closeJournalSchemaVersion ? journal : undefined
  } catch {
    return undefined
  }
}

/** Writes the journal atomically; a failure throws so the caller can refuse to mutate further. */
export async function writeCloseJournal(commonDir: string, journal: CloseJournal): Promise<void> {
  const path = journalPath(commonDir, journal.branch, journal.changeID)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  await Bun.write(tmp, JSON.stringify(journal, null, 2))
  await rename(tmp, path)
}

/** Removes the journal once its receipt is consumed or the attempt is superseded. */
export async function clearCloseJournal(commonDir: string, branch: string, changeID: string): Promise<void> {
  await rm(journalPath(commonDir, branch, changeID), { force: true }).catch(() => {})
}

/**
 * The protected close refs for one attempt: the post-archive feature tip and
 * the landing candidate. Create-only, so repeated attempts and later closes
 * never overwrite earlier evidence (the same guarantee the run-finalization
 * refs give per-run history).
 */
export function closeEvidenceRefPrefix(branch: string, attemptID: string): string {
  return `refs/convoy/close/${journalSlug(branch)}/${journalSlug(attemptID)}`
}

export function closeFeatureTipRef(branch: string, attemptID: string): string {
  return `${closeEvidenceRefPrefix(branch, attemptID)}/feature-tip`
}

export function closeCandidateRef(branch: string, attemptID: string): string {
  return `${closeEvidenceRefPrefix(branch, attemptID)}/candidate`
}

/** Creates one evidence ref only when absent; a failure means evidence is not durable. */
export async function protectCloseRef(ref: string, sha: string, cwd: string): Promise<void> {
  if (await refExists(ref, cwd)) return
  await createRefIfAbsent(ref, sha, cwd)
}

/**
 * Whether `landing` is still reachable from the base branch tip — the receipt
 * check for resume and cleanup (design D7). An unknown base or landing is not
 * evidence of anything and reports false.
 */
export async function isLandingReachable(landing: string, baseRef: string, cwd: string): Promise<boolean> {
  const base = await resolveCommit(baseRef, cwd)
  if (!base) return false
  const commit = await resolveCommit(landing, cwd)
  if (!commit) return false
  return isAncestor(landing, baseRef, cwd)
}

/** Resolves the repository's Git common dir for close journals, or undefined. */
export async function closeCommonDir(cwd: string): Promise<string | undefined> {
  return gitCommonDir(cwd)
}

/** One guarded ref movement: `git update-ref <ref> <new> <expected>` refuses when the branch moved. */
export async function updateRefIfUnchanged(ref: string, newSha: string, expectedSha: string, cwd: string): Promise<void> {
  await execFile("git", ["update-ref", "-m", "convoy: close landing", ref, newSha, expectedSha], { cwd })
}
