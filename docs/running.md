# Running Convoy

[Documentation](README.md) · [Convoy](../README.md)

Launch, observe, resume, and inspect runs from the CLI or TUI.

- [Usage](#usage)
- [Anatomy of a Run](#anatomy-of-a-run)
- [Reviewing a run before starting](#reviewing-a-run-before-starting)

## Usage

From the root of the target repo, ideally on a working branch:

In an interactive terminal, a truly bare `convoy` opens the home launcher. Move with `↑`/`↓` or `j`/`k`, press `Enter`, or jump directly with `p` (Pipelines), `s` (Specs), `r` (Runs), and `c` (Config); `q`, `Esc`, and `Ctrl-C` exit. Returning from a destination reopens Home on the worktree you were viewing; leaving Home ends the session. Any argv, including `--dir`, follows normal CLI parsing, and bare Convoy without interactive stdin/stdout keeps its existing non-TUI run semantics.

```bash
# home launcher: choose Pipelines, Specs, Runs, or Config
convoy

# Pipelines opens the run launcher: choose a pipeline, enter the prompt,
# set options, name the branch, then review

# inline prompt
convoy "Add onboarding screen with 3 steps and local persistence of progress"

# prompt from file
convoy --prompt-file prd.md

# attach files or directories to all phases
convoy --prompt-file prd.md --file src/features/onboarding --file tests/onboarding.test.ts

# run a project-defined pipeline (see the Configuration guide)
convoy --prompt-file bug.md --pipeline bug-fix

# only one step
convoy --prompt-file prd.md --only implementer

# skip steps
convoy --prompt-file prd.md --skip security,design

# force a different model for all steps
convoy --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# run headless: no dashboard, the coordinator's log streams to this terminal
# and the exit code matches the run
convoy --prompt-file prd.md --no-tui

# drop human gates (for pipelines that define them)
convoy --prompt-file prd.md --no-human-step

# resume a failed run (phases that already wrote their report are skipped,
# and the dashboard restores their real duration, cost, and session).
# If a phase was interrupted before its commit and left the working tree dirty,
# an interactive resume asks whether to commit those changes as that phase and
# continue with the following ones.
convoy --resume 20260519-103045-x7q2

# browse run history in the dashboard TUI: a selectable list (newest first,
# with status, date, cost, and prompt) plus a details panel with the per-phase
# breakdown. A run still executing shows a green ● "running" and can be
# attached. ↑/↓ select, [enter] re-open its dashboard (attach if it's live,
# else reconstruct it for inspection), [r]etry starts a brand-new run from
# step 0 using the selected run's original prompt and pipeline config (a
# confirmation modal asks y/n), [R]esume re-runs only the failed/unfinished
# phases of the existing run, [s]ummary/reports overlay, subshell in the run
# [d]ir under ~/.convoy/runs (exit to return), [q]uit.
# Pass a run ID to open the browser with that run preselected.
# Without a TTY (pipes/CI) it falls back to a plain listing.
convoy runs
convoy runs 20260519-103045-x7q2

# view and edit the global (~/.convoy) and current project config in a TUI:
# two tabs (Global / Project), pick models with autocomplete, edit pipelines
# and steps, or initialize a starter config when none exists.
convoy config

# create project-local config and prompt files you can customize
convoy init

# create global defaults (~/.convoy) instead of project-local
convoy init --global

# overwrite an existing config file
convoy init --force

# auto-allow ask-level permissions (the hard denylist still applies)
convoy --prompt-file prd.md --yolo

# smart auto-accept: an AI judge allows safe requests and escalates risky ones
convoy --prompt-file prd.md --smart --smart-model anthropic/claude-haiku-4-5

# delete the run dir after successful completion (kept by default)
convoy --prompt-file prd.md --no-keep-run-dir

# change the base branch used to calculate diffs between phases
# (when omitted, convoy auto-detects it: origin's default branch, else
# main/master/develop/trunk, else the current branch)
convoy --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
convoy --prompt-file prd.md --include-dirty
```

In interactive terminals, Convoy shows a full-screen OpenTUI dashboard headed by a compact run summary (clock, elapsed, cost, tokens). The `pipeline` panel on the left is a tab selector: every step — done, running, or still scheduled — is a row you move through with `↑`/`↓` (or `j`/`k`), or by clicking, with `▸` marking the focused one. Focusing a step drives the whole right side to it: a detail panel (name; whether it's ongoing, done, failed, or scheduled; model; cost; tokens; attempt; files changed) over that step's todo list and a three-tab content panel — switched with `←`/`→`, `Tab`, the number keys `1`/`2`/`3`, or by clicking the tab strip. The tabs are `logs` (the step's color-coded activity feed), `reports` (the markdown report that step wrote, if any, scrollable with `PgUp`/`PgDn` — available live the moment a step finishes, not only at the end), and `session` (a read-only "follow along" view of that step's OpenCode session: its live state — reasoning, running a command, editing, applying a diff — model, attempt, cost, diff summary, and a scrolling transcript of what the model is doing, newest at the bottom). A not-yet-started step reads as `scheduled` with its planned model and zeroed usage, so you can inspect what's coming; focus auto-follows the active step until you navigate, and `Esc` hands it back to auto-follow. The dashboard never paints backgrounds: the canvas is your terminal's own background and panels are delineated by borders alone, derived as subtle elevations of the terminal's reported background color, with dark or light accents picked by its brightness (and a neutral fallback when the terminal doesn't answer); floating modals repaint the reported color exactly to mask the content beneath them. It follows live theme changes. For full interactivity, press `o` (or click the detail panel) to open the focused step's OpenCode session in a new terminal window attached to Convoy's running OpenCode server; clicking a pipeline row only focuses that step — it no longer opens the session. Inside Herdr or Zellij that session opens in a sibling pane instead (see below); otherwise Ghostty is preferred when installed and Terminal.app is the fallback (`CONVOY_TERMINAL=herdr|zellij|ghostty|terminal` forces a backend). Press `Shift+Tab` to cycle auto-accept modes — off, auto-accept, smart (see the permission gate below). Press `Ctrl+C` once to abort the active OpenCode session and shut down Convoy cleanly; press it again to force exit if cleanup hangs. Human gates stay inside the dashboard (`c` continue · `o` open OpenCode · `a` abort); without a TTY dashboard they fall back to plain terminal prompts. A step that fails now waits for you instead of retrying: the dashboard shows a `step failed` gate with `r` retry clean (restore the baseline and run again), `o` open the OpenCode session and fix it by hand, `a` abort — no auto-retry, no lost work. Once you open the session (`o`), the gate becomes the interactive one and `c` unlocks; `c` delivers the step's report (including one written in the reopened session), and without any valid report it re-opens the gate instead of advancing to the next step. Use `--no-tui` to fall back to plain logs.

When Convoy runs inside Herdr or Zellij (including over SSH), `o` and `i` open OpenCode in a focused sibling pane rather than a macOS window, named for what it holds (`opencode session`, `opencode iterate`, `claude session`). Inside Herdr the pane splits the current one to the right; inside Zellij it is a new pane. The multiplexer's normal focus shortcut returns to Convoy without closing the pane. When OpenCode exits the pane deliberately stays, showing the exit code — so a session that failed to start is readable instead of vanishing; press `Ctrl+C` there to close the pane, or `Enter` to run it again. Set `CONVOY_TERMINAL=herdr`, `zellij`, `ghostty`, or `terminal` to override automatic backend selection — any other value is rejected with an error rather than silently ignored. When both multiplexers are detected, Herdr wins because the session runs inside it — and a failed Herdr open never falls through to Zellij, which would talk to the outer session and hang or open a pane you cannot see. If Convoy is inside a multiplexer but can't find its binary on its own `PATH`, it falls back to a macOS window rather than losing session opening altogether.

Inside Herdr the sidebar agent is **Convoy** — the live pipeline name, the `N/M` step counter, and the current step label — not the underlying OpenCode session. A Herdr config can render those with the sidebar agents block:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent", "$pipeline"],
  ["$progress", "$step"],
]
```

The available tokens are `$pipeline`, `$progress` (`N/M`, counting a `parallel:` or `models:` fan-out as one step), `$step`, `$summary`, and `$run_id` (the Convoy run id, never an OpenCode session id). `rows_by_agent.convoy` is not available until Herdr knows Convoy's canonical id; custom agents use the plain `rows` form above.

A failed step opens a `step failed` gate instead of retrying: `r` restores its clean baseline and launches a new attempt, `o` opens the session so you can fix it by hand (then `c` is available to continue), and `a` aborts the run without reverting the tree. The step's OpenCode window stays owned by its phase while the gate is open: `write_report` in the reopened session still lands in that step's file. Pressing `c` re-resolves the step's report and delivers it to the pipeline; pressing `c` with no valid report does not advance the step — the gate re-opens with `phase produced an empty report` until a report is rescued, the step is retried, or the run is aborted.

During a live run, `Ctrl+P` opens the command palette for operational controls such as pause/resume, permission policy, interactive takeover, usage, and keyboard help. On macOS it also offers **Keep Mac awake**, which starts `caffeinate` only for the current Convoy process to prevent display and idle sleep; it is off by default, never written to run metadata, and is released when the pipeline ends, fails, or is aborted. The palette also lists **Send to background**: it releases this terminal and lands you on the runs menu with the run marked `● running` — the pipeline keeps going (OpenCode stays live, the lease is held). Closing the terminal does not kill the run; recover it from `convoy runs` at any time.

Model messages in `session`, phase reports, and run summaries render their Markdown with distinct heading, emphasis, list, quote, link, and code styles. GFM pipe tables are drawn as real bordered tables, with column alignment honored, cells wrapped when the panel is narrow, and a per-row labelled-record fallback when no table can fit the width; lists mark each nesting level and hang wrapped text under their own column; paragraphs reflow to the panel (hard breaks respected); and setext headings, indented code, escapes, and bare-URL autolinks all render. `logs` messages wrap under the timestamp column instead of being cut at one row. From any phase `session`, `reports`, or `logs` tab, press `v` for a full-screen reader. It supports the keyboard controls (`↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`) plus mouse-wheel scrolling and a draggable scrollbar; in a report reader, `c` copies the complete original report. Press `v` or `Esc` to return.

On terminals 84 columns wide or narrower, the dashboard becomes a single column: the scrollable pipeline selector moves to the top and the step, todos, and content panels follow below it.

Press `i` on a running step to arm **interactive takeover**: the step's session opens in a new terminal window (like `o`) and, from that moment, a clean finish no longer commits by itself — the dashboard holds an `interactive session` gate and waits for you. Stop the agent from the OpenCode window (`esc`) or let it finish, then decide: `c` commits whatever the working tree holds as the step's commit and continues the pipeline (the step's rescue-written report is picked up and delivered first, if one exists), `o` reopens the session window, `a` aborts the run leaving the tree untouched. Press `i` again before the attempt ends to disarm and let a clean finish commit and move on.

Every step, armed or not, already waits for you on a failure: convoy never retries a failed step on its own (see the `step failed` gate in the dashboard walkthrough above). `[i]` only adds the *success* hold — it never brings back retries.

When the run ends (success or failure), the dashboard doesn't close — it stays on the very same layout, now frozen for browsing. The pipeline is still the tab selector: move with `↑`/`↓` (or `j`/`k`, or click a phase) to inspect any phase's outcome, duration, model, cost, and diff, and switch its `logs`/`reports`/`session` tabs exactly as during the run (`PgUp`/`PgDn` scroll long reports). Press `o` to open the selected phase's OpenCode session in a new terminal window (the server stays alive while the screen is up), `i` to start a fresh OpenCode session in the target project with the run's PRD and reports as context, and `g` to open lazygit in the target repo as a subshell — `git log --graph --decorate --stat` is the fallback when lazygit isn't installed. Press `q`, `Esc`, or `Ctrl+C` to close; only then does Convoy clean up the run dir and stop its OpenCode server. Failed runs pre-select the failed phase and show its error.

This same dashboard is reachable after the fact from `convoy runs`: pressing `enter` on a run re-opens it without resuming. A run that is still executing is a **coordinated** process: every production run now launches a detached coordinator and the dashboard is a client that attaches to it. If nobody else is attached, the dashboard is the **controller** — the same controls as the live dashboard (pause, permission policy, keep-awake, interactive takeover, gates, and background) — and pressing `enter` on a live run from the menu attaches with control. While a controller is attached, a second `convoy runs` attaches **read-only** (observer). `Ctrl+C` on a menu-attached controller detaches back to the runs menu; the palette's **Abort the run** ends the pipeline behind a y/n confirmation (default No). A live legacy run whose coordinator has no control server still attaches read-only as before. Goal-loop runs stay one coordinator across iterations, and the attached dashboard follows each `reset` to the next iteration — the clock, cost, and score trajectory keep running. A live run parked on an unanswered permission or human gate shows `waiting for a permission` / `waiting for review` in the runs browser's details. Attaching to that dashboard and pressing `[o]` reopens the **same** session, so a `write_report` made there is captured by the step's still-live report session and delivered when `[c]` continues the gate. If the run has stopped (completed, failed, or interrupted), Convoy **reconstructs** it from metadata + on-disk reports and shows the browsable finish screen, where `[o]` opens a phase's stored session standalone (`opencode <dir> --session <id>`, its own server, read from disk). Closing the dashboard returns you to the run browser. This works because a run records its server URL and pid in `metadata.json` while it executes and clears them on clean shutdown, so a lingering entry that no longer answers marks a run that died mid-flight. The pipeline process is independent of the dashboard, so closing the terminal never aborts the run — recover it from `convoy runs`.

Phases run asynchronously: Convoy fires the prompt with OpenCode's async API and detects completion through the event stream (`session.idle` / `session.error`), with a 30-second session-status poll as fallback and automatic event-stream reconnection. No HTTP request stays open for the duration of a phase, so long-running phases are immune to client-side socket timeouts. Convoy also disables OpenCode's total provider request timeout for its default providers and keeps a 10-minute provider stream idle timeout instead.

## Anatomy of a Run

Each invocation creates `~/.convoy/runs/<run-id>/`:

```
~/.convoy/runs/20260519-103045-x7q2/
├── prd.md
├── metadata.json
├── reports/
│   ├── implementer.md
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   ├── tests.md
│   ├── adversarial.md
│   └── run-report.md
├── diffs/
│   ├── patterns.pre.diff
│   ├── security.pre.diff
│   ├── design.pre.diff
│   ├── tests.pre.diff
│   └── adversarial.pre.diff
├── logs/
│   ├── implementer.1.json
│   └── ...
└── SUMMARY.md
```

`metadata.json` records the resolved pipeline the run executes plus each step's status, session ID, timing, cost, tokens, and model as the run progresses (written atomically, debounced). On `--resume`, the frozen pipeline is replayed — even if `.convoy/config.yaml` changed since — and steps that already wrote their report are restored in the dashboard with their real duration, cost, and session, which can still be opened by clicking the pipeline row.

`SUMMARY.md` is the mechanical archive — every phase report concatenated — while `reports/run-report.md` (on the `implement` pipelines) is the one-page extractive distillation written for a human to read first. Read the recap, then open the full archive only where it points you.

The run dir is kept after the run by default (browse it with `convoy runs`); pass `--no-keep-run-dir` to delete it on successful completion. If the run fails, it's always preserved for inspecting reports, diffs, and logs.

The target repo only sees commits with prefix `convoy(<phase>): ...`, made on the run's branch — by default a new one in its own worktree, so your checkout is untouched until you merge. When a run completes, its commits compact automatically into one conventional commit of your own (see [Finishing a run](safety.md#finishing-a-run)). Each new run also stores a git-ignored, private copy of its prompt under `.convoy/prd-history/`; set `defaults.prdHistory: false` to disable it. `convoy init` intentionally creates `.convoy/config.yaml` when you want project-local configuration.

## Reviewing a run before starting

Every interactive manual run now displays its fully resolved plan before repository effects. The launcher has a native **Review** step after Options: use Enter or `s` to start, Escape to return to Options, `q` to cancel, arrow/page keys or the mouse wheel to scroll, and `p` to expand the complete prompt. `--plan` prints that plan and exits without creating a run, running hooks, or starting OpenCode. `--no-confirm` prints a compact plan and starts immediately. Non-TTY environments continue automatically after the compact summary.

---

[Back to documentation](README.md)
