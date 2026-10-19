---
name: convoy
description: Run, compose, and monitor Convoy pipelines from this session. Convoy carries a big coding task across many fresh agent sessions (implement, audit, test, then score and fix until the branch reaches a quality bar), or runs multi-model reviews and audits, on OpenCode and/or Claude Code. Use when the user asks to run Convoy or a Convoy pipeline, hand a large task off to a pipeline, run a multi-model review or audit, build an ad hoc pipeline for a use case, or check on, answer, or abort a Convoy run.
---
<!-- convoy:skill -->

# Convoy

Convoy is a CLI that runs a **pipeline**: an ordered list of agent steps, each in a fresh session, each ending in a report (and a commit when the step writes code). Pipelines can fan steps out across models, run them in parallel, consult an advisor model, and end in a **goal loop** that scores the branch and fixes gaps until it reaches a target (90/100 in the built-ins). Runs are checkpointed, resumable, and keep their reports, transcripts, and costs under `~/.convoy/runs/<run-id>/`.

From an agent session you drive it headless: compose or pick a pipeline, launch it **detached**, poll it with `convoy runs <id> --wait`, answer what it asks, and report the results.

Use Convoy for work that would outgrow one session or deserves independent verification: a feature from a PRD, a branch review, a repo-wide audit, a batch of findings to fix. Don't use it for a change you can make yourself in a few minutes; a run costs real money and takes minutes to hours.

## Ground rules

- **Confirm before launching.** Tell the user which pipeline, what it will do (does it write code? which models?), where it runs (branch or worktree), and that it bills their providers. Launch once they agree. A read-only review they asked for by name needs no extra round-trip.
- **Use `--smart`, not `--yolo`.** `--smart` lets a judge model auto-allow safe requests and escalates risky ones to you. Use `--yolo` only when the user explicitly asks for it.
- **Never answer a permission request on your own.** Show it to the user and approve or deny it with their answer.
- **Never publish on your own.** `convoy publish --yes` pushes and opens a PR; run it only when the user asks. `--dry-run` is always fine.
- **Don't edit the user's Convoy config** (`.convoy/config.yaml`, `~/.convoy/config.yaml`) to run something once. Write a pipeline file instead (see below).

## 1. Check the install and discover

```bash
convoy --version                  # missing? install: curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | sh
convoy pipelines                  # every runnable pipeline (built-in, global, project) and the agents you can compose with
convoy pipelines show <name>      # one pipeline's steps: agent, model, runner, advisor, read-only, parallel groups, goal loop
convoy --help                     # every launch flag
```

Add `--json` to `convoy pipelines` for machine-readable output. Run these in the repository the work is about (or pass `--dir <path>`): project pipelines and config live there.

## 2. Pick or compose a pipeline

Built-ins (check `convoy pipelines` for the current list and descriptions):

| Pipeline | Changes code? | Use it for |
|---|---|---|
| `full-cycle` (default) | yes | Implement a feature from a prompt/PRD, audit, test, then score and fix to 90/100 |
| `implement` | yes | Implement and audit, with a one-page recap; no scoring loop |
| `ship` | yes | Sync the branch with its base, review, fix accepted findings, reach 90/100 |
| `review` | no | Findings plus a verified quality score for the current branch |
| `fixer` | yes | Prove supplied findings with regression tests, fix them, verify |
| `hunter` | no | Maximum-coverage repo audit: six tracks across five models |
| `claude-full-cycle` / `claude-review` | yes / no | The same on Claude Code alone (no OpenCode needed) |

When nothing fits — a different model mix, a narrower audit, a custom sequence — **write a pipeline file**: one YAML mapping with `steps`, built from the agents `convoy pipelines` lists. Read [references/pipeline-files.md](references/pipeline-files.md) (or `convoy skill show references/pipeline-files.md`) for the schema, the rules, and worked examples. Put it in a scratch location unless the user wants to keep it, then validate it:

```bash
convoy pipelines show --pipeline-file /tmp/payments-audit.yaml   # schema errors, resolved steps
```

## 3. Write the prompt

Every step receives the prompt. Write it to a file: the goal, the scope (paths, modules), constraints, and what "done" means. For a review or audit, say what to look at and what matters most. A pipeline with a `defaultPrompt` (`review`, `ship`, `hunter`) can run without one.

## 4. Check the plan, then launch detached

```bash
convoy --pipeline review --prompt-file /tmp/task.md --manual --smart --plan < /dev/null
```

`--plan` prints the fully resolved plan (models after routing, permissions, target checkout, attachments) and starts nothing. Summarize it for the user. Then launch the same command with `--detach` instead of `--plan`:

```bash
convoy --pipeline review --prompt-file /tmp/task.md --manual --smart --detach < /dev/null
# or: convoy --pipeline-file /tmp/payments-audit.yaml --prompt-file /tmp/task.md --manual --smart --detach < /dev/null
```

It prints `run <run-id> started (coordinator <pid>, detached)` and returns; the run keeps going in the background. Keep the run id.

- `--manual` or `--change <id>`: in a repo using OpenSpec, a headless launch must say whether it implements an OpenSpec change (`--change <id>`, repeatable) or runs without one (`--manual`). Harmless elsewhere.
- Where it runs: on a trunk branch (`main`, …) a run isolates itself in a new worktree and branch; on any other branch it runs in place. Force it with `--worktree` / `--no-worktree`, and name the branch with `--branch feat/…`.
- A run in place refuses a dirty working tree unless you pass `--include-dirty`, which folds the uncommitted changes into the run's first commit. Ask the user before using it; a fresh worktree is always clean.
- Other useful flags: `--file <path>` (attach files to every step), `--only`/`--skip <steps>`, `--model <provider/model>` (force every OpenCode step), `--base <ref>`, `--dir <repo>`.
- Without `--detach` the launch blocks, streams the run's log, and exits with the run's code. Avoid that from an agent session: runs outlive shell tool timeouts.

## 5. Monitor

```bash
convoy runs <run-id> --wait --timeout 5m     # blocks until the run ends, stops at a gate, or the timeout passes
convoy runs <run-id> --json                  # full snapshot: state, phases, cost, waiting request, report paths, log path
```

`--wait` prints phase changes as they happen, then a summary. Its exit code says what to do next:

| Exit | Meaning | Next |
|---|---|---|
| 0 | completed | Go to step 7 |
| 1 | ended without success (failed, aborted, interrupted) | Read the reports and log; offer `convoy --resume <run-id>` |
| 2 | still running, the wait timed out | Give the user a one-line progress update (phase, cost), then wait again |
| 3 | waiting for an answer | Go to step 6 |

Keep each `--wait` shorter than your shell tool's timeout: in Claude Code, `--timeout 9m` with a 10-minute Bash timeout, or run it in the background and get notified when it exits. Elsewhere, stay under the tool's limit (`--timeout 4m` is a safe default). Long runs take many waits; between them, don't re-read everything, just report the delta.

`convoy runs <run-id> --json` fields: `state` (`running`, `waiting`, `completed`, `failed`, `incomplete`, `unknown`), `phases[]` (`name`, `status`, `model`, `cost`), `cost`, `waiting` (the pending request), `goal` (`target`, `score`, `trajectory`, `outcome`), `summaryPath`, `reports[]`, `logPath` (the coordinator's log while the run is live; `tail -n 50` it to see what a step is doing), and `targetDir` (the checkout the run works in). `convoy runs --json` lists every run.

## 6. Answer a waiting run

A run waits when a tool call needs approval (`waiting.kind: "permission"`, with `permission`, `command`, `patterns`, `description`) or at a human gate (`waiting.kind: "review"`). Show the user exactly what is being asked, then:

```bash
convoy runs <run-id> approve <request-id>            # allow once
convoy runs <run-id> approve <request-id> --always   # allow this pattern for the rest of the run
convoy runs <run-id> deny <request-id>
convoy runs <run-id> abort                           # stop the run; resumable later with convoy --resume <run-id>
```

The request id is `waiting.requestId` from `--json`, also printed by `--wait`. Human gates are off in detached runs unless you pass `--human-step`; if one is waiting, the user answers it in a terminal with `convoy runs <run-id>`, or you abort. Answers refuse while a dashboard is attached to the run: the user is answering there.

## 7. Report the results

When the run completes:

1. Read `SUMMARY.md` (`summaryPath`) and the reports that matter (`reports[]`): findings, scores, what each step changed.
2. Tell the user: outcome, the quality score and its trajectory if the pipeline had a goal loop (`goal.score`, `goal.trajectory`, `goal.outcome`), total cost, and the branch or worktree (`targetDir`) holding the work.
3. For a run that changed code: `git -C <targetDir> log --oneline <base>..HEAD` and `git diff <base>...HEAD --stat` show what landed (successful runs compact their commits into one). Offer next steps: review the diff, run the project's tests, `convoy publish --dry-run` in that checkout to preview the PR.
4. For a failed run: the failing phase's report and the log tail usually say why. Offer `convoy --resume <run-id> --smart --detach < /dev/null`, which skips the phases that already finished.

## Troubleshooting

| Message | Fix |
|---|---|
| `no change is selected: pass --change <id> … or --manual` | Add `--manual` (or the change the user means) |
| `permissions: interactive — requests wait for an answer` | You forgot `--smart`; requests will wait for `approve`/`deny` |
| `working tree is not clean` (the run fails right after starting) | Commit or stash first, run in a worktree (`--worktree`), or, if the user agrees, `--include-dirty` |
| `Claude billing: an unattended launch must state its billing decision` | The pipeline uses Claude Code; ask the user to set `defaults.claudeAuth.billingPolicy: account-policy` in their Convoy config (it acknowledges that subscription usage may bill) |
| `another managed writer owns <checkout>` | Another run is writing there; wait for it, or run in a new worktree (`--worktree`) |
| `unknown pipeline "<name>"` | Check `convoy pipelines`; for a file, use `--pipeline-file` |
| `agent "<name>" has no prompt` / `needs agent "<name>"` | The pipeline names an agent that doesn't exist; pick one from `convoy pipelines` |
| A step loops or burns money | `convoy runs <run-id> abort`; Convoy's loop guard also stops a phase over its step or cost budget |
| `run <id> is not running; nothing to answer` | It already ended: `convoy runs <run-id> --json` |
