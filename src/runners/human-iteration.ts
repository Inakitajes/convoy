/**
 * Human-iteration commit provenance (change `runner-parity-opencode-v2`, task 11.5).
 *
 * A human iteration through either supported harness produces a Convoy-created
 * commit with exactly one authoritative `Convoy-Run` trailer. This module renders
 * that message from Convoy-owned inputs (never agent-supplied trailers): one
 * subject, up to three bounded detail lines, and the trailer.
 */

import type { RunnerId } from "./contracts"

export type HumanIterationCommit = {
  runId: string
  runner: RunnerId
  /** A concrete repository outcome, when one is available. */
  summary?: string
  /** Up to three concrete detail lines. */
  details?: readonly string[]
  /** A bounded fallback derived from change evidence (e.g. changed paths). */
  fallbackSummary?: string
}

export type RenderedCommit = { subject: string; body: string[]; trailer: string }

const maxSubjectLength = 72
const maxDetailLength = 120
const maxDetails = 3

/** Collapses to one line and strips control bytes and markdown heading markers. */
export function sanitizeLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Removes any trailer-shaped line an agent might have embedded. */
export function stripTrailers(value: string): string {
  return value
    .split("\n")
    .filter((line) => !/^\s*[A-Za-z-]+:\s/.test(line) || !/convoy-run/i.test(line))
    .join("\n")
}

function shortenSubject(value: string): string {
  if (value.length <= maxSubjectLength) return value
  const slice = value.slice(0, maxSubjectLength)
  const boundary = slice.lastIndexOf(" ")
  return (boundary > 0 ? slice.slice(0, boundary) : slice).trim()
}

/** Renders the commit message, guaranteeing exactly one run trailer. */
export function renderHumanIterationCommit(commit: HumanIterationCommit): RenderedCommit {
  const rawSummary = commit.summary && commit.summary.trim().length > 0 ? commit.summary : commit.fallbackSummary ?? `human ${commit.runner} iteration`
  const subject = shortenSubject(sanitizeLine(stripTrailers(rawSummary))) || `human ${commit.runner} iteration`

  const body: string[] = []
  for (const detail of commit.details ?? []) {
    if (body.length >= maxDetails) break
    const clean = sanitizeLine(stripTrailers(detail))
    if (clean.length === 0) continue
    body.push(clean.slice(0, maxDetailLength))
  }

  return { subject, body, trailer: `Convoy-Run: ${commit.runId}` }
}

/** The full commit message: subject, optional body, blank line, trailer. */
export function formatCommitMessage(rendered: RenderedCommit): string {
  const lines = [rendered.subject]
  if (rendered.body.length > 0) {
    lines.push("", ...rendered.body.map((line) => `- ${line}`))
  }
  lines.push("", rendered.trailer)
  return lines.join("\n")
}
