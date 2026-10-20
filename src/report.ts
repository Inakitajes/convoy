import {
  qualityDimensions,
  type QualityDimension,
  type QualityDimensionScores,
} from "./quality-score"
import { validateCommitDescription, type StepCommitDescription } from "./step-commit"

export { renderQualityScoreReport } from "./quality-score"

/** The OpenCode custom tool every executor uses to persist its phase report. */
export const writeReportToolName = "write_report"

/** A report should be large enough for evidence, not large enough to exhaust the run disk. */
export const maxReportMarkdownChars = 100_000

export type ReportConfidence = "high" | "medium" | "low"

/** The fields a scoring agent supplies; Convoy derives score and verdict itself. */
export type QualityScoreReportFields = {
  dimensions: QualityDimensionScores
  mustFix: string[]
  gaps?: Partial<Record<QualityDimension, string>>
  confidence?: ReportConfidence
}

/** The structured commit description a writable phase may submit with its report. */
export type CommitDescriptionPayload = {
  subject: string
  details?: string[]
}

export type WriteReportPayload = {
  markdown: string
  dimensions?: QualityDimensionScores
  mustFix?: string[]
  gaps?: Partial<Record<QualityDimension, string>>
  confidence?: ReportConfidence
  commit?: CommitDescriptionPayload
}

export type ValidatedWriteReportPayload = {
  markdown: string
  scoring?: QualityScoreReportFields
  commit?: StepCommitDescription
}

/** Quality agents are the only ones allowed to supply the structured score inputs. */
export function isScoringAgent(agentName: string): boolean {
  const base = agentName.replace(/__(?:ro|verify)$/u, "")
  return base === "quality-scorer" || base === "quality-score-report"
}

/**
 * What one phase's write_report call may carry: commit metadata only when the
 * phase is writable (it creates a step commit), scoring fields only when its
 * agent scores. The offered tool schema follows it, and
 * validateWriteReportPayload enforces the same rules.
 */
export type WriteReportScope = { writable: boolean; scoring: boolean }

export function writeReportScope(agentName: string, readOnly: boolean | undefined): WriteReportScope {
  return { writable: !readOnly, scoring: isScoringAgent(agentName) }
}

/**
 * Validates data crossing the OpenCode/Convoy bridge. This is intentionally
 * stricter than the report parser: malformed tool arguments should fail the
 * call while the agent still has the same turn available to correct them.
 * `writable` is false for read-only phases, which cannot create a step commit
 * and therefore may not supply commit metadata.
 */
export function validateWriteReportPayload(value: unknown, scoringAgent: boolean, writable = true): ValidatedWriteReportPayload | { error: string } {
  if (!isRecord(value)) return { error: "write_report arguments must be an object" }
  if ("score" in value || "verdict" in value) return { error: "write_report does not accept score or verdict; Convoy derives both from dimensions" }
  const markdown = value.markdown
  if (typeof markdown !== "string" || markdown.trim() === "") return { error: "markdown must be a non-empty string" }
  if (markdown.length > maxReportMarkdownChars) return { error: `markdown must be at most ${maxReportMarkdownChars} characters` }

  // Structured commit metadata is validated before the scoring early-return so
  // a rejection (including read-only usage) never replaces a prior valid
  // report candidate silently.
  let commit: StepCommitDescription | undefined
  if ("commit" in value && value.commit !== undefined) {
    if (!writable) return { error: "read-only phases cannot supply commit metadata: they never create a step commit" }
    const parsed = validateCommitDescription(value.commit)
    if ("error" in parsed) return parsed
    commit = parsed.commit
  }

  const scoreKeys = ["dimensions", "mustFix", "gaps", "confidence"]
  if (!scoringAgent && scoreKeys.some((key) => key in value)) {
    return { error: "only quality-scorer and quality-score-report may supply scoring fields" }
  }
  if (!scoringAgent) return commit ? { markdown, commit } : { markdown }

  const dimensions = parseDimensions(value.dimensions)
  if (!dimensions) return { error: dimensionsError(value.dimensions) }
  const mustFix = parseMustFix(value.mustFix)
  if (!mustFix) return { error: "mustFix must be an array of strings" }
  const gaps = parseGaps(value.gaps)
  if (gaps === false) return { error: "gaps must map quality dimensions to non-empty strings" }
  const confidence = value.confidence
  if (confidence !== undefined && confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return { error: "confidence must be high, medium, or low" }
  }

  return {
    markdown,
    scoring: {
      dimensions,
      mustFix,
      ...(gaps && Object.keys(gaps).length > 0 ? { gaps } : {}),
      ...(confidence ? { confidence } : {}),
    },
    ...(commit ? { commit } : {}),
  }
}

function parseDimensions(value: unknown): QualityDimensionScores | undefined {
  if (!isRecord(value)) return undefined
  const dimensions = {} as QualityDimensionScores
  for (const dimension of qualityDimensions) {
    const score = value[dimension]
    if (!isScore(score)) return undefined
    dimensions[dimension] = Math.round(score)
  }
  return dimensions
}

/**
 * Names every problem at once, with what was received, so the agent can fix
 * the whole call in its next attempt instead of one dimension per rejection.
 */
function dimensionsError(value: unknown): string {
  const expected = `an object scoring every quality dimension (${qualityDimensions.join(", ")}) from 0–100`
  if (value === undefined) return `dimensions is required: ${expected}`
  if (!isRecord(value)) return `dimensions must be ${expected} (received: ${received(value)})`
  const missing = qualityDimensions.filter((dimension) => value[dimension] === undefined)
  const problems: string[] = []
  if (missing.length > 0) {
    const keys = Object.keys(value)
    problems.push(`dimensions is missing ${missing.join(", ")} (received: ${keys.length > 0 ? keys.join(", ") : "no keys"})`)
  }
  for (const dimension of qualityDimensions) {
    const score = value[dimension]
    if (score !== undefined && !isScore(score)) problems.push(`dimensions.${dimension} must be a number from 0–100 (received: ${received(score)})`)
  }
  return problems.join("; ")
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}

/** A short rendering of a rejected value for an error message. */
function received(value: unknown): string {
  const text = typeof value === "number" ? String(value) : (JSON.stringify(value) ?? String(value))
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function parseMustFix(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((finding) => typeof finding !== "string")) return undefined
  return value
}

function parseGaps(value: unknown): Partial<Record<QualityDimension, string>> | false | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return false
  const gaps: Partial<Record<QualityDimension, string>> = {}
  for (const [dimension, gap] of Object.entries(value)) {
    if (!qualityDimensions.includes(dimension as QualityDimension) || typeof gap !== "string" || gap.trim() === "") return false
    gaps[dimension as QualityDimension] = gap
  }
  return gaps
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
