## Why

A pipeline whose terminal step is a `goal` loop has no step after it, so opening the pull request is a post-hook's job. The run-aware PR composer (`composePrText`) — title from the branch's conventional prefix plus the OpenSpec proposal, body with Why / What / How-tested from the proposal, the run recap, and validation reports — is today reachable only from the interactive run dashboard. Headless publication has no equivalent: the common hook `gh pr create --fill` uses raw commit subjects, and `convoy worktrees pr` composes a generic Why ("Not disclosed in the selected inputs") from the branch alone. A quality-loop pipeline that finishes headlessly therefore cannot open the same semantically composed PR a human would create from the dashboard.

## What Changes

- Add a headless `convoy publish` command as the explicit non-interactive publication request for a run:
  - resolves the target checkout (default: current directory) and the run context (`--run-dir <path>` or `--run <id>`);
  - discloses the plan (branch, remote, base) and composes the **run-aware** PR title and body;
  - prints the composed text for review and applies it (normal push + PR) only with explicit `--yes`;
  - `--dry-run` composes and prints without any effect.
- Support `--title` / `--body` overrides that win over composed text, matching the seam's `accepted` input.
- Reuse the existing publication seam (`createPublishSeam`) unchanged, so current-target validation, existing-open-PR lookup, non-force push, retry/reconciliation, and compaction-recovery gating all apply as-is.
- Add command help and README documentation.
- **Non-goal**: no automatic publication on run completion. The command is invoked explicitly — e.g. from a pipeline post-hook gated on `CONVOY_GOAL_REACHED` — so "completion is not publication consent" still holds.

## Capabilities

### New Capabilities

<!-- None: this extends the existing publication surface. -->

### Modified Capabilities

- `run-finalization`: the "Run dashboards delegate independent worktree publication" requirement gains a headless explicit publication request (`convoy publish`) with reviewed output and explicit `--yes` authorization; the "PR drafts describe the reviewed current branch" requirement's operator-review clause is satisfied headlessly by the printed composition plus `--yes` (or inspected with `--dry-run`) instead of the TUI review dialog.

## Impact

- `src/cli.ts`: a new `CliCommand` variant, `parseCommand` parsing, dispatch, and `help()`.
- New `src/publish-command.ts`: the headless prepare → compose → (review) → apply flow over `createPublishSeam`.
- `src/publish.ts`: reused; no behavior change (types may be re-exported).
- Tests: a new `test/publish-command.test.ts` following the injected-runner pattern of `test/publish.test.ts`.
- `README.md`: usage and the run-completion/publication distinction.
