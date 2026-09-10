import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { closeJournalSchemaVersion, journalSlug, readCloseJournalValue, type CloseJournal } from "./close-journal"

/**
 * Legacy unresolved-operation inspector and scoped conflict guard (change
 * `worktree-control-center`, task 2.5): old feature close journals may hold
 * half-applied repository effects. They are inspected as legacy evidence —
 * original bytes preserved, never imported into the new domain, never
 * deleted here — and only mutations that genuinely conflict with an
 * unresolved journal are blocked, with manual reconciliation guidance.
 * Old receipts alone authorize nothing.
 */

export type LegacyCloseObservation =
  | {
      status: "found"
      kind: "close-journal"
      branch: string
      changeId: string
      phase: CloseJournal["phase"]
      /** A half-applied close: prepared/candidate, or landed with its checkout unmaterialized. */
      unresolved: boolean
      attemptId: string
      candidateSha?: string
      landingSha?: string
      baseRef: string
      baseSha: string
      updatedAt: number
      path: string
      /** The protective refs this journal family created, when derivable. */
      refPrefix?: string
    }
  | { status: "corrupt"; path: string; reason: string }

/** The legacy close journals of one repository, read-only. */
export async function inspectLegacyCloseJournals(commonDir: string): Promise<LegacyCloseObservation[]> {
  const dir = join(commonDir, "convoy", "close")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: LegacyCloseObservation[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = join(dir, name)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (error) {
      out.push({ status: "corrupt", path, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      out.push({ status: "corrupt", path, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const journal = readCloseJournalValue(parsed)
    if (!journal) {
      out.push({
        status: "corrupt",
        path,
        reason:
          typeof (parsed as Record<string, unknown> | null)?.schemaVersion === "number" &&
          (parsed as Record<string, unknown>).schemaVersion !== closeJournalSchemaVersion
            ? "unsupported journal schema version"
            : "journal failed legacy validation",
      })
      continue
    }
    const unresolved = journal.phase !== "landed" || journal.checkoutMaterialized === false
    out.push({
      status: "found",
      kind: "close-journal",
      branch: journal.branch,
      changeId: journal.changeID,
      phase: journal.phase,
      unresolved,
      attemptId: journal.attemptID,
      ...(journal.candidateSha ? { candidateSha: journal.candidateSha } : {}),
      ...(journal.landingSha ? { landingSha: journal.landingSha } : {}),
      baseRef: journal.baseRef,
      baseSha: journal.baseSha,
      updatedAt: journal.updatedAt,
      path,
      ...(journal.attemptID ? { refPrefix: `refs/convoy/close/${journalSlug(journal.branch)}/` } : {}),
    })
  }
  return out
}

/** One mutation a legacy journal conflicts with. */
export type LegacyConflict = {
  legacy: Extract<LegacyCloseObservation, { status: "found" }>
  reason: string
  remediation: string
}

/**
 * Whether a mutation that touches `branch` (sync/archive/squash/close/remove/
 * delete-branch on that checkout) conflicts with an unresolved legacy close
 * journal for the same branch. The guard is scoped: only the branch the
 * legacy half-applied work lives on is blocked, and only while the journal
 * is genuinely unresolved; unrelated worktrees and resolved legacy records
 * stay usable. Original evidence is never touched by this check.
 */
export async function legacyConflictsForBranch(input: { commonDir: string; branch: string }): Promise<LegacyConflict[]> {
  const observations = await inspectLegacyCloseJournals(input.commonDir)
  const conflicts: LegacyConflict[] = []
  for (const observation of observations) {
    if (observation.status !== "found" || !observation.unresolved) continue
    if (observation.branch !== input.branch) continue
    const why =
      observation.phase === "landed"
        ? `a legacy close landed its squash but never materialized the base checkout (attempt ${observation.attemptId})`
        : `a legacy close stopped mid-sequence at phase "${observation.phase}" (attempt ${observation.attemptId})`
    conflicts.push({
      legacy: observation,
      reason: `${why} on branch "${observation.branch}" (change ${observation.changeId})`,
      remediation: `inspect the legacy journal at ${observation.path} and reconcile its effects against current Git state before re-running work on this branch; the original evidence is preserved until you explicitly resolve it`,
    })
  }
  return conflicts
}

/** All unresolved legacy journals in the repository, for listing surfaces. */
export async function listUnresolvedLegacyOperations(commonDir: string): Promise<Extract<LegacyCloseObservation, { status: "found" }>[]> {
  const observations = await inspectLegacyCloseJournals(commonDir)
  return observations.filter((observation): observation is Extract<LegacyCloseObservation, { status: "found" }> => observation.status === "found" && observation.unresolved)
}
