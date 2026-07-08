import adversarialReviewer from "../prompts/adversarial-reviewer.md" with { type: "text" }
import bugAuditor from "../prompts/bug-auditor.md" with { type: "text" }
import cleanCodeAuditor from "../prompts/clean-code-auditor.md" with { type: "text" }
import designPolisher from "../prompts/design-polisher.md" with { type: "text" }
import implementationFinalReview from "../prompts/implementation-final-review.md" with { type: "text" }
import implementationFixer from "../prompts/implementation-fixer.md" with { type: "text" }
import implementationTriage from "../prompts/implementation-triage.md" with { type: "text" }
import implementationValidator from "../prompts/implementation-validator.md" with { type: "text" }
import implementer from "../prompts/implementer.md" with { type: "text" }
import patternAuditor from "../prompts/pattern-auditor.md" with { type: "text" }
import reviewAdversary from "../prompts/review-adversary.md" with { type: "text" }
import reviewFixer from "../prompts/review-fixer.md" with { type: "text" }
import reviewReport from "../prompts/review-report.md" with { type: "text" }
import reviewScope from "../prompts/review-scope.md" with { type: "text" }
import reviewValidator from "../prompts/review-validator.md" with { type: "text" }
import runtimeSafety from "../prompts/runtime-safety.md" with { type: "text" }
import securityAuditor from "../prompts/security-auditor.md" with { type: "text" }
import securityReviewer from "../prompts/security-reviewer.md" with { type: "text" }
import testEngineer from "../prompts/test-engineer.md" with { type: "text" }

/**
 * Built-in agent prompts embedded as text at bundle time, so the compiled
 * binary never reads the source tree's prompts/ directory at runtime. Every
 * file in prompts/ must have an import above and an entry here (a test in
 * agents.test.ts enforces this).
 */
export const builtInPrompts: Record<string, string> = {
  "adversarial-reviewer": adversarialReviewer,
  "bug-auditor": bugAuditor,
  "clean-code-auditor": cleanCodeAuditor,
  "design-polisher": designPolisher,
  "implementation-final-review": implementationFinalReview,
  "implementation-fixer": implementationFixer,
  "implementation-triage": implementationTriage,
  "implementation-validator": implementationValidator,
  implementer,
  "pattern-auditor": patternAuditor,
  "review-adversary": reviewAdversary,
  "review-fixer": reviewFixer,
  "review-report": reviewReport,
  "review-scope": reviewScope,
  "review-validator": reviewValidator,
  "runtime-safety": runtimeSafety,
  "security-auditor": securityAuditor,
  "security-reviewer": securityReviewer,
  "test-engineer": testEngineer,
}
