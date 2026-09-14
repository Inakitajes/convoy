# Quality and goal loops

[Documentation](README.md) · [Convoy](../README.md)

Read the scoring rubric and configure bounded improve-and-measure loops.

- [Quality scoring](#quality-scoring)
- [Goal mode](#goal-mode)

## Quality scoring

`full-cycle`, `ship` and `review` end the run with a **measurement**, not just a findings list. The problem with open-ended review is that it is open-ended: an agent asked to "find problems" will always find one more, and its severities are ranked against whatever it happened to find — so a cosmetic nit can come back labeled `critical`. Scoring inverts that: the agent grades against a **fixed, closed contract** — the rubric — and every number must carry evidence a maintainer can check.

`ship` runs a bounded review-and-fix prefix first — a report-only scan, an adversarial triage, and a single fix pass — so obvious gaps are closed before measurement rather than left for the scorer to re-weigh as an open-ended audit. Measurement is still independent: the prefix's fixes are graded by fresh scorers, and the goal loop then closes only what the score still reports.

### The rubric

The built-in rubric (v1) scores six weighted dimensions, each 0–100 with absolute anchors:

| Dimension | Weight | What it measures |
|---|---|---|
| `prd` | 30% | The PRD is implemented: every requirement, including edge cases and non-happy paths. |
| `tests` | 20% | Behavioral coverage of the PRD's promises, **not** line coverage. A test that would not fail if the behavior it claims to cover were removed is worth nothing. |
| `security` | 15% | Security and robustness of the touched code only: input validation, authorization, injection, secrets, unsafe deserialization, error handling. |
| `maintainability` | 15% | Pattern alignment with the repository (with establishing evidence), complexity, duplication, naming, dead code, boundaries. |
| `operational` | 10% | Build, typecheck, lint, and tests green; i18n, migrations, no debug code, no accidental churn. |
| `scope` | 10% | Only what was asked changed: no unrelated refactors, dependency churn, or file churn. |

Severity is **absolute, not relative**: `critical` means "breaks a core promise of the PRD, is exploitable in touched code, or corrupts data", not "the worst thing I found". Findings deduct fixed points from their own dimension (critical −15, major −8, minor −2), and a change whose only findings are minor cannot score below 80. Coverage percentage is reported as a datum, never as a score.

A project overrides the rubric by adding `.convoy/quality-rubric.md` — same dimension names and anchors, its own weights and deductions. A project can also name a **comparison bar** in `.convoy/quality-bar.md` (a reference implementation, a target test suite, a latency target); the scorer compares the result against it directly, the way a visual critic compares against reference screenshots.

### How the score is produced

1. **Two independent scorers** (`quality-scorer`) grade the same diff against the same rubric, as fresh agents with no access to the implementer's session — the builder never grades itself. Each reports per-dimension scores with evidence, absolute-severity findings, and the concrete gaps that would raise the score.
2. **A consensus step** (`quality-score-report`) reconciles them (per-dimension median, judgment on disagreements >10 points), **verifies the load-bearing claims itself** by running the project's test/typecheck/lint commands, and emits the authoritative score.

The final score lands in `reports/score-report.md` with a machine-readable block:

````markdown
```quality-score
{
  "score": 87,
  "dimensions": { "prd": 92, "tests": 70, "security": 95, "maintainability": 88, "operational": 90, "scope": 85 },
  "verdict": "ready-with-caveats",
  "mustFix": ["SC-3: no test protects the cancellation path (major)"],
  "gaps": { "tests": "Add a regression test that fails when cancellation is removed" },
  "confidence": "high"
}
```
````

Verdicts map to the score: `ready` (≥90) · `ready-with-caveats` (75–89) · `not-ready` (60–74) · `failing` (<60). This block is the interface the goal loop acts on, and the one you read after a `review` to decide whether to merge or to follow up with a `fixer` run.

**Calibrate before you trust it.** The first few scored runs will grade "differently" from your judgment. Run `review` against 2–3 PRs you already know are good or bad, compare your expectation to the score, and adjust `.convoy/quality-rubric.md` (weights, anchors, deductions) until the score matches your call. The rubric is a contract; like any contract, it is only useful once you agree with it — and since `ship` gates your pull requests on it, calibrate it before you rely on that gate.

## Goal mode

Goal mode answers the "when is it enough?" question mechanically: **don't stop until the branch scores at or above a target**, or until the score stops improving.

A pipeline enters goal execution if and only if its definition contains one terminal `goal` step — the pipeline's last step. There are no goal CLI flags, no launcher toggle, and no separate `goal-fix` pipeline: the policy belongs to the pipeline, where it is reviewed and preflighted as part of the plan you confirm. The step owns its target, its stopping policy, and the two subflows that do the fixing and the measuring:

```yaml
pipelines:
  ship:
    steps:
      - agent: sync-with-base
        name: sync
        reports: none

      - goal:
          target: 90          # required, 1–100
          maxIterations: 5    # default 3: improvement rounds after iteration zero
          plateau: 3          # default 3: stop when an improvement adds fewer points

          improve:            # writable directed-fix subflow
            briefStep: fix    # exactly one step; it alone receives the score brief
            steps:
              - agent: goal-fixer
                name: fix
                reports: none
                diff: true
                prdHistory: true

          measure:            # read-only scoring subflow
            steps:
              - parallel:
                  - agent: quality-scorer
                    name: score
                    models: [openrouter/x-ai/grok-4.6#high, openrouter/z-ai/glm-5.3#high]
                    reports: none
                    prdHistory: true
              - agent: quality-score-report
                name: score-report
                reports: [score]
                verify: true
                prdHistory: true
```

This is the terminal goal step of the built-in `ship`, whose prefix syncs, reviews, triages, fixes, and recaps before it — so with `ship` this is simply what happens, no flag required:

```bash
convoy -p ship "what this branch does"          # measure, improve, re-measure until 90
```

Execution is measure-first and bounded:

```
Iteration 0:  sync → SCORERS → consensus                                  score 71
Iteration 1:  improve (exactly the reported gaps) → SCORERS → consensus   score 86  ✅
```

- **Fragments are internal.** `improve` and `measure` are fragments of the owning pipeline's plan, not selectable pipelines: they never appear in the launcher, `--only`/`--skip` cannot target them, and they are not retryable or resumable as standalone pipelines. Validation reads declared structure and deliverable contracts — never reserved names — so a custom goal can name its repair step and its consensus step anything, as long as the improve fragment can edit the repository and the measure fragment is read-only and ends in exactly one machine-readable quality-score deliverable (set `deliverable: quality-score` on an arbitrarily named consensus step).
- The **brief recipient** receives only the previous measurement's work order — the score, the per-dimension gaps, and the must-fix findings, sanitized and capped — as a per-step brief. Its job is to close exactly those gaps and nothing else: no new scope, no speculative improvements, no restructuring.
- The re-scorers are **blind to the previous score**: the brief goes to the configured brief step only, and every fragment invocation resolves with an empty report namespace, so a measurement cannot read the previous measurement's or the improvement's reports. A measurement that needs more evidence collects it inside its own fragment.
- The loop stops when any of these happens:
  1. **Score ≥ target** — done.
  2. **Plateau** — an improvement round raised the score by fewer than `plateau` points (default 3): it keeps reporting "you can do better", but the measurement says it isn't.
  3. **Iteration cap** — `maxIterations` improvement rounds (default 3) are exhausted.
  4. A fragment fails or a measurement produces no parseable score.

Legacy goal configuration — pipeline-level scalar `goal:`, `goalMaxIterations:`, `goalPlateau:`, or a top-level `pipelines.goal-fix` entry — no longer loads: Convoy refuses it with one aggregated diagnostic naming every legacy path and printing a copyable terminal-goal-step skeleton that preserves your target and stopping values. Nothing is silently converted, and your file is never rewritten. The name `goal-fix` is reserved.

Goal mode is a bounded loop, not an open cheque: the plateau and the iteration cap exist precisely so the loop cannot chase a score forever. If it stops below the target, the branch is left at the best measured state and the final score report tells you what is still missing.

**The loop finishing is not the same as the goal being met.** A run that plateaus or exhausts its iterations below the target still ends successfully — it did what it was asked, it just could not get there. Post-hooks are therefore run **once, after the whole cycle and after automatic compaction**, and receive `CONVOY_GOAL_REACHED` (`true`/`false`), `CONVOY_GOAL_SCORE` and `CONVOY_GOAL_TARGET`, so a hook that opens a pull request can require the bar was actually cleared:

```yaml
hooks:
  pipelines:
    ship:
      post:
        - name: open PR
          command: |
            if [ "$CONVOY_GOAL_REACHED" = "true" ]; then
              convoy publish --run-dir "$CONVOY_RUN_DIR" --worktree "$CONVOY_TARGET_DIR" --yes
            else
              echo "scored $CONVOY_GOAL_SCORE, needed $CONVOY_GOAL_TARGET — no PR opened"
            fi
```

Success post-hooks also receive the compaction outcome — `CONVOY_FINALIZATION_STATE` plus the produced commit (`CONVOY_FINALIZATION_SHA`, `CONVOY_FINALIZATION_SUBJECT`) and `CONVOY_FINALIZATION_REASON` when it did not complete — so a publish hook can require `completed` before pushing.

`convoy publish` is the explicit headless publication request. It composes the same run-aware title and Why / What / How-tested body the dashboard's **Create PR** action composes — the branch's conventional prefix plus the OpenSpec proposal title, grounded in the proposal, the run recap (`reports/run-report.md`), and the validation reports — prints the disclosed branch/remote/base and the exact text, and pushes and creates the PR **only under explicit `--yes`**. Without `--yes`, or with `--dry-run`, it prints the review and performs no effect, so a run completing never publishes on its own. It is deliberately distinct from `convoy worktrees pr`, which is worktree-only and composes a generic body from the branch slug and commit subjects.

```bash
# compose and inspect without any effect
convoy publish --run-dir ~/.convoy/runs/<id> --worktree . --dry-run

# compose, push, and create/report the PR
convoy publish --run-dir ~/.convoy/runs/<id> --worktree . --yes
```

The dashboard shows the goal, the current iteration, and the trajectory (`◆ convoy · goal 90 · iter 2/4 · 71 → …`), and when the cycle ends — goal met, plateau, iteration cap, no score, or a failure — the dashboard holds its finish screen **once**, with the verdict in place of the live goal readout (`✓ goal 92/100`, `plateau 86/100`, `cap 88/100`, `no score`, or `✗ run failed`) and the full trajectory (`71 → 84 → 92`); the terminal prints the trajectory and why it stopped after the dashboard closes. Goal fragment phases appear under the parent pipeline with their iteration-qualified names (for example `goal-measure-1-score-report`); the whole cycle runs in one run, so the dashboard never remounts between rounds.

---

[Back to documentation](README.md)
