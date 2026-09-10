import { execFile } from "./git"

/**
 * The GitHub pull-request merge state, read through `gh pr view` and reported
 * as unknown on any failure (change `close-lands-via-github-pr`, design D4).
 * The hosted-close reality probe (operation-reconcile) and the hosted landing
 * effect (close-hosted) reconcile by this same receipt — one implementation so
 * both agree on what "unreadable" means.
 */
export type PrMergeState = {
  state?: string
  /** GitHub's squash/merge commit, when the query resolved a 40-hex SHA. */
  mergeCommit?: string
  /** Set when the state could not be read; the state fields stay undefined. */
  reason?: string
}

export async function readPrMergeState(prNumber: number, cwd: string): Promise<PrMergeState> {
  try {
    const gh = await execFile("gh", ["--version"], { cwd, allowFailure: true })
    if (gh.exitCode !== 0) return { reason: "the GitHub CLI is not installed or not usable" }
    const result = await execFile("gh", ["pr", "view", String(prNumber), "--json", "state,mergeCommit"], { cwd, allowFailure: true })
    if (result.exitCode !== 0) return { reason: (result.stderr || result.stdout).trim().slice(0, 200) || "the pull-request query failed" }
    const parsed = JSON.parse(result.stdout) as { state?: unknown; mergeCommit?: unknown }
    return {
      state: typeof parsed.state === "string" ? parsed.state : undefined,
      mergeCommit: typeof parsed.mergeCommit === "string" && /^[0-9a-f]{40}$/i.test(parsed.mergeCommit) ? parsed.mergeCommit : undefined,
    }
  } catch (error) {
    return { reason: `the GitHub CLI could not be run: ${error instanceof Error ? error.message : String(error)}` }
  }
}
