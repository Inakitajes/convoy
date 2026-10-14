/**
 * Offline run transcript reader (change `runner-parity-opencode-v2`, task 9.4).
 *
 * Reads a run's captured event journal from disk without a live harness,
 * credentials, or model calls. Missing history is reported honestly, and a gap
 * in the recorded sequence is surfaced rather than hidden, so a late reader can
 * tell captured content from content that was never captured.
 */

import { RunnerJournal, type JournalRecord } from "./journal"

export type TranscriptGap = { from: number; to: number }

export type RunTranscript = {
  records: JournalRecord[]
  /** False when nothing was captured (the caller should show a placeholder). */
  hasHistory: boolean
  /** False when a sequence gap or a degraded journal means content is missing. */
  complete: boolean
  gaps: TranscriptGap[]
}

/** Computes contiguous gaps in an ascending sequence list. */
export function findGaps(sequences: readonly number[]): TranscriptGap[] {
  const gaps: TranscriptGap[] = []
  let previous = 0
  for (const seq of sequences) {
    if (seq > previous + 1) gaps.push({ from: previous + 1, to: seq - 1 })
    previous = Math.max(previous, seq)
  }
  return gaps
}

/**
 * Reads persisted records for `journalPath`. A missing or unreadable journal
 * yields an empty, honest result rather than an error.
 */
export async function readRunTranscript(journalPath: string, fromSeq = 1): Promise<RunTranscript> {
  const journal = new RunnerJournal({ path: journalPath })
  let records: JournalRecord[] = []
  try {
    records = await journal.readPersisted(fromSeq)
  } catch {
    records = []
  }
  const sequences = records.map((record) => record.seq)
  const gaps = findGaps(sequences)
  return {
    records,
    hasHistory: records.length > 0,
    complete: records.length > 0 && gaps.length === 0,
    gaps,
  }
}
