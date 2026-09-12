import { join } from "node:path"

import { createPublishSeam, type PublishPlan, type PublishSeam } from "./publish"
import { runsRoot } from "./workspace"

/**
 * Options accepted by `convoy publish` (capability run-finalization, delta
 * add-headless-publish). Parsed by `parsePublishArgs`; this module owns the
 * flow, not the flag spelling.
 */
export type PublishCommandOptions = {
  /** Target checkout; defaults to the process working directory. */
  worktree?: string
  /** Run workspace whose recap/metadata seed the PR body and enable the run gates. */
  runDir?: string
  /** Run id resolved under the runs root when `runDir` is absent. */
  runId?: string
  /** Explicit title; valid only together with `body`. */
  title?: string
  /** Explicit body; valid only together with `title`. */
  body?: string
  /** Authorize the push + PR effects. Without it the command only reviews. */
  yes: boolean
  /** Compose and print only; never an effect. */
  dryRun: boolean
}

/**
 * The subset of the publication seam the command needs, so tests can inject a
 * stub and the real seam satisfies it structurally.
 */
export type PublishCommandSeam = Pick<PublishSeam, "prepare" | "compose" | "apply">

export type PublishCommandDeps = {
  /** Injected seam for tests; defaults to a real seam rooted at the checkout. */
  seam?: PublishCommandSeam
  /** Injected stdout/stderr sinks for tests. */
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

/**
 * The explicit headless publication request (capability run-finalization):
 * prepare → compose → print the reviewed plan/text → apply only under `--yes`.
 * Reuses the same seam as the dashboard, so every current-target, provenance,
 * recovery, non-force-push, and existing-PR guard is unchanged. Returns the
 * process exit code; a blocked stage prints the seam's message verbatim.
 */
export async function runPublishCommand(options: PublishCommandOptions, deps: PublishCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text))
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text))

  const cwd = options.worktree ?? process.cwd()
  const runDir = resolvePublishRunDir(options)
  const seam = deps.seam ?? createPublishSeam({ cwd, ...(runDir !== undefined ? { runDir } : {}) })

  const prepared = await seam.prepare()
  if (!prepared.ok) {
    stderr(`blocked: ${prepared.message}\n`)
    return 1
  }

  const composed = await seam.compose(prepared.plan)
  if (!composed.ok) {
    stderr(`blocked: ${composed.message}\n`)
    return 1
  }

  const title = options.title ?? composed.title
  const text = options.body ?? composed.text
  stdout(renderPublishReview(prepared.plan, title, text))

  if (options.dryRun) {
    stdout("dry run: no push or pull request was made\n")
    return 0
  }
  if (!options.yes) {
    stdout("no effect: review the text above, then pass --yes to publish\n")
    return 0
  }

  const applied = await seam.apply(prepared.plan, { title, text })
  if (!applied.ok) {
    stderr(`blocked: ${applied.message}\n`)
    return 1
  }
  if (applied.outcome.url !== undefined) {
    stdout(`pull request: ${applied.outcome.url}\n`)
  } else {
    stdout(`pushed ${prepared.plan.remote}/${prepared.plan.branch} (no pull request URL was reported)\n`)
  }
  return 0
}

/** The run workspace the seam should read: explicit dir first, else the run id under the runs root. */
function resolvePublishRunDir(options: PublishCommandOptions): string | undefined {
  if (options.runDir !== undefined) return options.runDir
  if (options.runId !== undefined) return join(runsRoot(), options.runId)
  return undefined
}

/** The disclosed plan and the exact text that a `--yes` invocation would apply. */
function renderPublishReview(plan: PublishPlan, title: string, text: string): string {
  return [`branch: ${plan.branch}`, `remote: ${plan.remote}`, `base:   ${plan.base}`, "", `title: ${title}`, "", text, ""].join("\n")
}
