/**
 * Contract-based phase deliverable validation (moved out of the engine by
 * change `unify-runner-system`, task 2.1).
 *
 * Distinct from the submission validator in `runners/deliverables.ts`: this one
 * validates the artifact an engine phase produced against its phase contract.
 */

import { parseQualityScoreReport, qualityDimensionWeights, type QualityDimension } from "../quality-score"
import type { DeliverableContract } from "../types"

export function validateDeliverableContract(
  contract: DeliverableContract,
  reportText: string,
  weights: Record<QualityDimension, number> = qualityDimensionWeights,
): { valid: true } | { valid: false; error: string } {
  switch (contract.kind) {
    case "none":
      return { valid: true }
    case "markdown-report":
      return reportText.trim() ? { valid: true } : { valid: false, error: "phase produced an empty report" }
    case "quality-score-report":
      return parseQualityScoreReport(reportText, weights)
        ? { valid: true }
        : { valid: false, error: "phase produced an invalid quality-score report" }
  }
}
