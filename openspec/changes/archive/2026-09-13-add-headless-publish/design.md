## Context

See `proposal.md` — Why. The relevant current state:

- `src/publish.ts` already implements the deliberate publication action as a seam, `createPublishSeam({ cwd, runDir })`, with `prepare()` (target/provenance/remote/base validation), `compose(plan)` (the run-aware `composePrText`), and `apply(plan, accepted?)` (normal non-force push, existing-open-PR lookup, create/report).
- `src/publish-action.ts` is the only caller: an interactive TUI review (`showPublishReviewTui`) between `compose` and `apply`.
- `convoy worktrees pr` is headless but uses a different composer (`composePrDraft`, branch/commits only) and a different journaled path (`runPrOperation`).
- CLI commands are dispatched in `src/cli.ts` from a `CliCommand` union built by `parseCommand`.

## Goals / Non-Goals

**Goals:**

- A headless, non-interactive publication request that produces the same reviewed-quality PR text as the dashboard, by reusing `createPublishSeam` unchanged.
- Preserve every existing guard: current-target validation, provenance gate, recovery gate, non-force push, existing-open-PR lookup.
- Make "completion is not publication consent" explicit in the command's own interface.

**Non-Goals:**

- Automatic publication on run completion or on goal settlement.
- Changing `composePrText` / `composePrDraft`, or merging the two publication paths.
- A model-composed PR text; composition stays deterministic.

## Decisions

### Decision: a new `convoy publish` command, not a flag on `convoy worktrees pr`

Two publication paths already exist: the run-aware seam (`composePrText`, used by the dashboard) and `runPrOperation` (`composePrDraft`, used by `convoy worktrees pr`). Reusing the run-aware seam is the whole point (proposal — Why), and `createPublishSeam` is already exported and injectable.

- **Chosen:** `convoy publish` wraps `createPublishSeam` directly.
- **Alternative (rejected):** add `--run-dir` to `convoy worktrees pr`. It would entangle the two seams and the journaled PR-operation semantics, and force `composePrDraft` to grow run-aware behavior it was not designed for.

### Decision: effects require explicit `--yes`; `--dry-run` composes and prints only

The interactive surface inserts a review dialog. Headless has no dialog, so the command replaces it with two explicit modes rather than defaulting to publish:

- `convoy publish --dry-run ...` → prints the disclosed plan (branch/remote/base) and the composed title/body; no push, no PR.
- `convoy publish --yes ...` → prints the same review, then pushes and creates/reports the PR.
- Invoked with neither → the same review is printed and the command exits without effects (so the default is safe).

### Decision: inputs are the checkout and an optional run context

- `--worktree <path>` — the target checkout; defaults to the process working directory. A pipeline post-hook runs in `CONVOY_TARGET_DIR`, so the default already points at the branch.
- `--run-dir <path>` (or `--run <id>`, resolved under the runs root) — the run workspace whose recap and metadata seed the body and enable the provenance/recovery gates. A pipeline post-hook passes `CONVOY_RUN_DIR`.
- `--title <text>` / `--body <text>` — explicit overrides passed as the seam's `accepted` text (both must be present to override, matching the seam's contract).
- The PR base is resolved by the seam exactly as the dashboard resolves it; no separate `--base` flag is added in this change.

### Decision: plain stdout and exit codes

Headless callers (post-hooks, CI) need parseable status, not a TUI. `publish` prints the plan, the composed text (`title` / body), and the final outcome (pushed refspec and PR URL, or existing PR), and exits non-zero with the seam's message when `prepare`/`compose`/`apply` is not ok.

### Decision: the pipeline hook is the caller, and it gates on the goal

The motivating caller is a post-hook, e.g.:

```sh
if [ "$CONVOY_GOAL_REACHED" = "true" ]; then
  convoy publish --run-dir "$CONVOY_RUN_DIR" --worktree "$CONVOY_TARGET_DIR" --yes
fi
```

The command stays a general explicit action; the goal gating lives in the hook, where the pipeline already owns its policy.

## Risks / Trade-offs

- **Headless publish could apply unintended text** → the default is no-effect review; effects need `--yes`, and `--dry-run` exists for inspection. The composed text is deterministic (no model), so what is printed is what is applied.
- **Two similar PR surfaces (`publish` vs `worktrees pr`)** → they are documented as distinct: `publish` is run-aware and semantic; `worktrees pr` is worktree-only with a generic body. README and `--help` state the difference.
- **`--run-dir` provenance gate may refuse when the run's recorded boundary no longer matches the checkout** → this is existing intended behavior; the command surfaces the seam's message verbatim, so the operator gets the same remediation as the dashboard.
