import { createPublishSeam, type PublishPlan, type PublishSeam } from "./publish"
import { showNoticeTui } from "./notice-tui"
import { showPublishReviewTui, type PublishReviewResult } from "./publish-review-tui"

import type { TuiRoute } from "./tui-session"

/**
 * The Home `Create pull request` action as one reviewed transaction: resolve and
 * disclose the destination, compose the PR text, let the operator review/edit or
 * cancel, then push the branch and open the pull request — reporting the outcome
 * in a dialog instead of writing raw stdout over the alternate screen.
 *
 * It reuses the publication seam (`createPublishSeam`), so the branch is pushed
 * before the PR is created and located before being created again, never forced.
 * The interactive surface previously bypassed this seam, which created PRs from
 * a stale remote head and painted `git`/`gh` output over the live UI.
 */
export type InteractivePublishDeps = {
  /** Injectable publication seam (defaults to a real seam rooted at the worktree). */
  seam?: PublishSeam
  /** Injectable review gate for tests. */
  review?: (route: TuiRoute, options: { plan: PublishPlan; title: string; text: string }) => Promise<PublishReviewResult>
  /** Injectable notice dialog for tests. */
  notice?: (route: TuiRoute, options: { title: string; message: string }) => Promise<void>
}

export async function runInteractivePublish(
  input: { worktree: string; route: TuiRoute },
  deps: InteractivePublishDeps = {},
): Promise<void> {
  const seam = deps.seam ?? createPublishSeam({ cwd: input.worktree })
  const review = deps.review ?? showPublishReviewTui
  const notice = deps.notice ?? showNoticeTui

  const prepared = await seam.prepare()
  if (!prepared.ok) {
    await notice(input.route, { title: "create pull request", message: prepared.message })
    return
  }
  const composed = await seam.compose(prepared.plan)
  if (!composed.ok) {
    await notice(input.route, { title: "create pull request", message: composed.message })
    return
  }

  const choice = await review(input.route, { plan: prepared.plan, title: composed.title, text: composed.text })
  if (choice.kind !== "publish") return

  // The push and the `gh` calls own the terminal while they run (they may prompt
  // for credentials); hand it back for the duration, exactly as the run
  // dashboard's publication does.
  const renderer = input.route.session.renderer
  renderer.suspend()
  let result: Awaited<ReturnType<PublishSeam["apply"]>>
  try {
    result = await seam.apply(prepared.plan, { title: choice.title, text: choice.text })
  } finally {
    renderer.resume()
  }

  if (result.ok) {
    const lines = [`pushed ${prepared.plan.branch} to ${prepared.plan.remote}/${prepared.plan.branch}`]
    lines.push(
      result.outcome.url
        ? `pull request: ${result.outcome.url}`
        : "no pull request URL was reported — verify on the host whether a PR was created",
    )
    await notice(input.route, { title: "pull request", message: lines.join("\n") })
  } else {
    await notice(input.route, { title: "create pull request", message: result.message })
  }
}
