# archer

Archer is a higher-level orchestration harness for [OpenCode](https://opencode.ai) that turns a PRD into a structured, reviewable implementation workflow. It coordinates specialized agents across implementation, pattern alignment, security, design polish, tests, and adversarial review; adapts to the target repo's stack and conventions; and leaves one commit per phase.

Rather than being only a sequential agent chain, Archer owns the operational layer around OpenCode: repo context attachment, runtime guard rails, permission gates, phase reports, diff tracking, and human-in-the-loop checkpoints.

Pipelines are data, not code: archer ships a family of built-in pipelines (`implement` — the default — plus `ultra-implement`, `refine`, `ultra-refine`, and a report-only `review`; see [Built-in pipelines](#built-in-pipelines)), and a project can define its own — any number of steps, its own agents, its own models, with `human-review` gates anywhere — in `.archer/config.yaml`.

Archer is written in Bun + TypeScript and uses `@opencode-ai/sdk` to control OpenCode. The SDK starts/controls the OpenCode server; Archer no longer manually calls `opencode run` nor parses stdout.

## The default pipeline: `implement`

`implement` is the pipeline archer runs when you don't pass `-p/--pipeline`.

```
PRD ──► implementer ──► patterns ──► security ──► design ──► tests ──► adversarial
         │               │            │            │          │         │
         └───────────────┴────────────┴────────────┴──────────┴─────────┘
                                          commit per phase
```

| Step | Agent | Model | What it does |
|---|---|---|---|
| `implementer` | `implementer` | `openai/gpt-5.5#xhigh` | Implements the feature respecting repo patterns |
| `patterns` | `pattern-auditor` | `openai/gpt-5.5#xhigh` | Refactors without changing behavior, aligns with the rest of the code |
| `security` | `security-auditor` | `openai/gpt-5.5#xhigh` | Audits and fixes security issues |
| `design` | `design-polisher` | `anthropic/claude-opus-4-8` | Polishes UI following the repo's design system |
| `tests` | `test-engineer` | `openai/gpt-5.5#xhigh` | Automated tests + relevant E2E/integration coverage |
| `adversarial` | `adversarial-reviewer` | `anthropic/claude-opus-4-8` | Final adversarial review before PR creation |

## Built-in pipelines

Archer ships these pipelines; select one with `-p/--pipeline` (no config needed). A project can add or override any of them in `.archer/config.yaml`.

| Pipeline | Changes code? | What it does |
|---|---|---|
| `implement` | yes | **The default** (runs with no `-p`). Implement a PRD, then audit, polish, test, and adversarial review (the table above). |
| `ultra-implement` | yes | Like `implement`, but the pattern/security/adversarial reviews of the initial diff run in parallel across two models feeding a triage step, and the run ends with an audit-only final review, a fixer that applies only blocking findings, and a final validator. |
| `refine` | yes | Audit the current diff (scope → bugs → clean-code → security), triage the findings adversarially, apply the accepted fixes, then validate them. |
| `ultra-refine` | yes | Like `refine`, but every read-only audit is fanned out across two models before triage, fixes, and validation. |
| `review` | **no — report only** | Scope the diff, run the bug / clean-code(+patterns) / security audits **in parallel across two models each**, then a single step synthesizes everything into one prioritized findings report. Makes no changes; the run's output is `reports/report.md`, which you read to decide whether to follow up with a `refine` run. |

`refine`/`ultra-refine` are the change-applying counterparts of `review`: run `review` first to get a report, then `refine` if you want the fixes applied.

## Requirements

- Bun 1.0+
- `opencode` installed and authenticated (`opencode auth login`)
- `git`

## Authentication And Providers

Archer does not store provider credentials. It starts `opencode serve` through the SDK and passes only runtime agent configuration via `OPENCODE_CONFIG_CONTENT`; the server inherits your shell environment and uses the credentials already configured in OpenCode.

Useful commands:

```bash
opencode providers list
opencode providers login --provider openai
opencode providers login --provider anthropic
opencode models openai
opencode models anthropic
```

To use different providers, authenticate them in OpenCode and select models as `provider/model`. Archer defaults to `openai/gpt-5.5` with variant `xhigh` for non-design phases, and `anthropic/claude-opus-4-8` for design and adversarial review.

## Installation

```bash
git clone <this-repo> archer
cd archer
bun install
make install
```

This leaves `archer` in `~/.local/bin/archer` and creates `~/.archer/config.yaml` plus `~/.archer/agents/*.md` with Archer's default configuration if they do not already exist. Make sure `~/.local/bin` is in your `PATH`.

## Usage

From the root of the target repo, ideally on a working branch:

```bash
# inline prompt
archer "Add onboarding screen with 3 steps and local persistence of progress"

# prompt from file
archer --prompt-file prd.md

# attach files or directories to all phases
archer --prompt-file prd.md --file src/features/onboarding --file tests/onboarding.test.ts

# run a project-defined pipeline (see "Project configuration" below)
archer --prompt-file bug.md --pipeline bug-fix

# only one step
archer --prompt-file prd.md --only implementer

# skip steps
archer --prompt-file prd.md --skip security,design

# force a different model for all steps
archer --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# disable the OpenTUI progress footer
archer --prompt-file prd.md --no-tui

# drop human-review gates (for pipelines that define them)
archer --prompt-file prd.md --no-human-review

# configure the app command used during manual review
archer --prompt-file prd.md --app-run-command "pnpm dev"

# optional Flutter emulator launch during manual review
archer --prompt-file prd.md --emulator Pixel_8 --app-run-command "flutter run -d emulator-5554"

# resume a failed run (phases that already wrote their report are skipped,
# and the dashboard restores their real duration, cost, and session).
# If a phase was interrupted before its commit and left the working tree dirty,
# an interactive resume asks whether to commit those changes as that phase and
# continue with the following ones.
archer --resume 20260519-103045-x7q2

# browse run history in the dashboard TUI: a selectable list (newest first,
# with status, date, cost, and prompt) plus a details panel with the per-phase
# breakdown. A run still executing shows a green ● "running" and can be
# attached. ↑/↓ select, [enter] re-open its dashboard (attach if it's live,
# else reconstruct it for inspection), [r]esume (re-runs the failed/unfinished
# phases), [s]ummary/reports overlay, subshell in the run [d]ir under
# ~/.archer/runs (exit to return), [q]uit.
# Pass a run ID to open the browser with that run preselected.
# Without a TTY (pipes/CI) it falls back to a plain listing.
archer runs
archer runs 20260519-103045-x7q2

# view and edit the global (~/.archer) and current project config in a TUI:
# two tabs (Global / Project), pick models with autocomplete, edit pipelines
# and steps, or initialize a starter config when none exists.
archer config

# create project-local config and prompt files you can customize
archer init

# create global defaults (~/.archer) instead of project-local
archer init --global

# overwrite an existing config file
archer init --force

# auto-allow ask-level permissions (the hard denylist still applies)
archer --prompt-file prd.md --yolo

# smart auto-accept: an AI judge allows safe requests and escalates risky ones
archer --prompt-file prd.md --smart --smart-model anthropic/claude-haiku-4-5

# preserve run dir after completion
archer --prompt-file prd.md --keep-run-dir

# change the base branch used to calculate diffs between phases
# (the ref is validated at startup; repos without a local main need this)
archer --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

In interactive terminals, Archer shows a full-screen OpenTUI dashboard headed by a compact run summary (clock, elapsed, cost, tokens). The `pipeline` panel on the left is a tab selector: every step — done, running, or still scheduled — is a row you move through with `↑`/`↓` (or `j`/`k`), or by clicking, with `▸` marking the focused one. Focusing a step drives the whole right side to it: a detail panel (name; whether it's ongoing, done, failed, or scheduled; model; cost; tokens; attempt; files changed) over that step's todo list and a three-tab content panel — switched with `←`/`→`, `Tab`, the number keys `1`/`2`/`3`, or by clicking the tab strip. The tabs are `logs` (the step's color-coded activity feed), `reports` (the markdown report that step wrote, if any, scrollable with `PgUp`/`PgDn` — available live the moment a step finishes, not only at the end), and `session` (a read-only "follow along" view of that step's OpenCode session: its live state — reasoning, running a command, editing, applying a diff — model, attempt, cost, diff summary, and a scrolling transcript of what the model is doing, newest at the bottom). A not-yet-started step reads as `scheduled` with its planned model and zeroed usage, so you can inspect what's coming; focus auto-follows the active step until you navigate, and `Esc` hands it back to auto-follow. The dashboard never paints backgrounds: the canvas is your terminal's own background and panels are delineated by borders alone, derived as subtle elevations of the terminal's reported background color, with dark or light accents picked by its brightness (and a neutral fallback when the terminal doesn't answer); floating modals repaint the reported color exactly to mask the content beneath them. It follows live theme changes. For full interactivity, press `o` (or click the detail panel) to open the focused step's OpenCode session in a new terminal window attached to Archer's running OpenCode server; clicking a pipeline row only focuses that step — it no longer opens the session. Ghostty is preferred when installed; Terminal.app is the fallback (`ARCHER_TERMINAL=ghostty|terminal` forces a backend). Press `Shift+Tab` to cycle auto-accept modes — off, auto-accept, smart (see the permission gate below). Press `Ctrl+C` once to abort the active OpenCode session and shut down Archer cleanly; press it again to force exit if cleanup hangs. The dashboard suspends for the whole `human-review` checkpoint — the prompts, your app command's output, and interactive OpenCode iterations own the terminal — and resumes when the gate finishes. Use `--no-tui` to fall back to plain logs.

When the run ends (success or failure), the dashboard doesn't close — it stays on the very same layout, now frozen for browsing. The pipeline is still the tab selector: move with `↑`/`↓` (or `j`/`k`, or click a phase) to inspect any phase's outcome, duration, model, cost, and diff, and switch its `logs`/`reports`/`session` tabs exactly as during the run (`PgUp`/`PgDn` scroll long reports). Press `o` to open the selected phase's OpenCode session in a new terminal window (the server stays alive while the screen is up), and `g` to open lazygit in the target repo as a subshell — `git log --graph --decorate --stat` is the fallback when lazygit isn't installed. Press `q`, `Esc`, or `Ctrl+C` to close; only then does Archer clean up the run dir and stop its OpenCode server. Failed runs pre-select the failed phase and show its error.

This same dashboard is reachable after the fact from `archer runs`: pressing `enter` on a run re-opens it without resuming. If the run is still executing (its OpenCode server is up — the browser marks it with a green ● "running"), Archer **attaches** to it: history is replayed from the run's metadata and the active phase's OpenCode events are mirrored into the dashboard in real time, read-only — `Ctrl+C` detaches without touching the run. If the run has stopped (completed, failed, or interrupted), Archer **reconstructs** it from metadata + on-disk reports and shows the browsable finish screen, where `[o]` opens a phase's stored session standalone (`opencode <dir> --session <id>`, its own server, read from disk). Either way, closing the dashboard returns you to the run browser. This works because a run records its server URL and pid in `metadata.json` while it executes and clears them on clean shutdown, so a lingering entry that no longer answers marks a run that died mid-flight.

Phases run asynchronously: Archer fires the prompt with OpenCode's async API and detects completion through the event stream (`session.idle` / `session.error`), with a 30-second session-status poll as fallback and automatic event-stream reconnection. No HTTP request stays open for the duration of a phase, so long-running phases are immune to client-side socket timeouts. Archer also disables OpenCode's total provider request timeout for its default providers and keeps a 10-minute provider stream idle timeout instead.

## Permission gate

Agents run with a restricted bash policy: a small allowlist of safe Flutter/Dart, web/Node, test/build, and read-only git commands; a denylist of unambiguously dangerous patterns (`git push*`, `gh*`, deployment/publish commands, `sudo*`, recursive deletes against `/` or `~`, `curl … | sh`, package installers); and everything else falls through to `ask`.

When an agent runs a command that isn't on the allowlist, Archer prints the request and prompts:

```
approve? [o]nce, [a]lways, [r]eject >
```

- `o` allows the single call.
- `a` allows future calls matching the same pattern for the rest of the run.
- `r` rejects the call (the agent receives a denial and decides what to do next).

In non-interactive runs (no TTY), unknown commands are auto-rejected and logged. Per-project, extend the lists with `permissions.allow`/`permissions.deny` in `.archer/config.yaml`; the global policy lives in `src/agents.ts` (`bashPolicy`).

Archer also allowlists the target repo's own `package.json` scripts whose names look like checks (`test`, `lint`, `typecheck`, `type-check`, `check`, `build`, `format`, `validate`, including suffixed forms like `test:unit`), excluding anything whose name suggests side effects (`deploy`, `publish`, `release`, `migrate`, `seed`, `reset`). Note the trust model: agents can edit the repo, including script bodies, so allowlisted scripts mean trusting the repo's contents — the denylist protects against accidents, it is not a security boundary against a malicious agent.

### Auto-accept (`--yolo` / `--smart` / `Shift+Tab`)

The permission gate has three states. In the dashboard, `Shift+Tab` cycles through them (`off → auto-accept → smart → off`) and the footer always shows the current one:

- **off** — every request that would normally *ask* prompts you.
- **auto-accept** (`--yolo`) — every ask-level request is allowed automatically (replied as "once") and logged to the activity feed. Switching into this state also resolves any prompts already queued.
- **smart** (`--smart`) — each request is handed to an external AI judge running *outside* the agentic loop (a single stateless prompt with every tool disabled, so it can only classify, never act). Requests it judges safe — read-only, local, reversible, no secrets, no exfiltration — are auto-allowed with the reason logged; anything it flags as risky (or any judge error/timeout) falls back to prompting you, with the flag shown in the modal. It is deliberately fail-closed: uncertainty never auto-approves.

The judge model is `--smart-model <provider/model[#variant]>`, falling back to `defaults.autoAcceptJudgeModel` in config, then the run's model. The hard denylist is enforced by OpenCode itself and is never relaxed: denied commands are rejected before they ever reach the gate, in every state.

## Commit safety

Before each commit Archer scans the staged files for common secret names (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `*.keystore`, ...). If any match, the commit is aborted, the index reset, and Archer asks you to add them to `.gitignore` (or delete them) before re-running. Combined with `--include-dirty` this is the only line of defense against accidentally publishing a secret your working tree had lying around — review the resulting commits with `git show` before pushing.

During `human-review`, Archer waits 10 seconds for an explicit action. If nobody answers, it prepares the configured app command in the target worktree. By default the app command is disabled; pass `--app-run-command "pnpm dev"`, `--app-run-command "flutter run"`, or the repo's equivalent. Archer only launches a Flutter emulator when `--emulator <id>` is explicitly provided.

## Project configuration (`.archer/config.yaml`)

A project can reshape archer entirely from one file. Everything is optional — the file only declares what differs from the defaults. The same schema also lives globally at `~/.archer/config.yaml` (see [Global configuration](#global-configuration)); the project file is merged on top of it.

```yaml
version: 1

defaults:
  model: openai/gpt-5.5#xhigh     # provider/model[#variant], used by steps with no model of their own
  maxAttempts: 2
  baseRef: main
  pipeline: quick                  # pipeline used when -p/--pipeline is not given
  appRunCommand: pnpm dev          # app command for human-review gates
  emulator: Pixel_8                # optional Flutter emulator for human-review gates
  interactiveModel: openai/gpt-5.5#xhigh
  autoAcceptJudgeModel: anthropic/claude-haiku-4-5   # model for smart auto-accept (--smart); defaults to the run's model

# Project agents: the prompt lives at .archer/agents/<name>.md (required).
# Naming a built-in agent here overrides its model/temperature/readOnly instead.
agents:
  api-reviewer:
    description: Reviews public API consistency
    model: anthropic/claude-opus-4-8
    temperature: 0.1
    readOnly: true               # disables write/edit/bash tools for this agent

pipelines:
  quick:
    description: Implementation, manual gate, tests
    steps:
      - implementer                # string = agent (or alias) with that step name
      - human-review               # reserved keyword: manual review gate, placeable anywhere, repeatable
      - agent: tests
        maxAttempts: 3
  api:
    steps:
      - implementer
      - api-reviewer               # project agent defined above
      - human-review
      - agent: security
        reports: all               # attach every previous step report (default: the nearest one)
      - agent: adversarial
        name: final-check          # step name (report file, commit prefix, --only/--skip)
        reports: [implementer, security]
  audit:
    steps:
      - implementer
      - parallel:                  # runs its steps concurrently; every one is forced read-only
          - patterns
          - security
          - agent: clean-code
            models:                # fans this one step out across models, one read-only run per model
              - anthropic/claude-opus-4-8
              - openai/gpt-5.5#xhigh
      - agent: adversarial
        name: triage
        reports: all               # every parallel/fan-out report from above, in one attachment set

permissions:                       # additive only; a config allow can never undo a deny
  allow:
    - "supabase gen types*"
  deny:
    - "stripe *"

attachments:                       # attached to every step, like repeatable --file flags
  - docs/architecture.md
```

The rules:

- **Precedence**: CLI flag > project config > global config > built-in default. Within a config, for models specifically: step `model` > agent `model` > `defaults.model` > the agent's built-in preference (opus for design/adversarial) > `openai/gpt-5.5#xhigh`. `--model` overrides everything.
- **Conventions over wiring**: every agent step gets the PRD, the cumulative diff against the base branch (except the first step; opt out with `diff: false`), and the previous step's report (`reports: previous|all|none|[names]`). Its report lands at `reports/<step>.md` and its commit is `archer(<step>): …`.
- **Aliases**: the built-in agents answer to their short names in steps — `patterns`, `security`, `design`, `tests`, `adversarial` — as well as their full names.
- **Read-only agents**: set `agents.<name>.readOnly: true` to enforce audit-only behavior. Archer disables the agent's write/edit/bash tools, denies edit/bash/task permissions, and saves the phase report from the assistant response if the agent cannot write it directly.
- **Parallel steps and model fan-out**: wrap steps in `parallel: [...]` to run them concurrently, and/or give one step a `models: [...]` list (instead of `model:`) to run it once per model. Both are always forced read-only, regardless of the underlying agent's own `readOnly` setting, so concurrent runs can never step on each other's changes to the tree — there's no per-step way to opt out. A `models:` step's variants get disambiguated names (`<step>__<model-slug>`) and reports; `reports: previous` after a parallel block attaches every member's report, and `reports: [<step-name>]` on a fanned-out step's un-suffixed name attaches every one of its model variants. `parallel:` can't nest and can't contain `human-review`.
- **Project pipelines shadow built-ins**: defining `pipelines.implement` replaces the built-in default pipeline.
- **`--no-human-review`** (and non-TTY runs) drop every `human-review` gate from the pipeline.
- **Resume is frozen**: the resolved pipeline is persisted in the run's `metadata.json`; `--resume` replays it even if the config changed since.
- **Dirty-tree recovery**: a phase interrupted before its commit (Ctrl+C, a failed commit step, a killed process) leaves uncommitted work in the tree, which normally blocks `--resume`. In an interactive terminal, resume offers to commit that work as the interrupted phase (`archer(<phase>): …`), mark it done, and continue with the following phases. Decline (or a non-TTY resume) keeps the old "commit/stash first" behavior.
- **Permissions are additive**: `permissions.deny` extends the hard denylist, `permissions.allow` extends the allowlist, deny always wins, and there is deliberately no way for a repo to grant itself `--yolo`.

## Global configuration

`~/.archer/config.yaml` uses the exact same schema as the project file and sets your personal defaults across every repo — most usefully `defaults.model`, but also custom agents and pipelines. Global custom agents bring their prompt at `~/.archer/agents/<name>.md` (the same convention a project uses, relative to your home).

Both files are merged before a run, with the project winning: `defaults`, `agents`, and `pipelines` merge by key/name (a project entry overrides the global one of the same name), while `permissions` and `attachments` concatenate (global first; `deny` still wins). The home directory archer reads can be relocated with `ARCHER_HOME` (it points at the directory that holds `.archer`, and also moves `~/.archer/runs`).

## Editing config interactively (`archer config`)

`archer config` opens a TUI to view and edit both configs without hand-editing YAML — two tabs, **Global** (`~/.archer/config.yaml`) and **Project** (the current repo's `.archer/config.yaml`):

- Pick models from an autocompleting list: it queries OpenCode for the models your enabled providers expose (including reasoning variants like `#xhigh`), falling back to the full [models.dev](https://models.dev) catalog when OpenCode can't answer, and always accepts a free-typed `provider/model[#variant]`.
- Edit `defaults` (model, interactiveModel, autoAcceptJudgeModel, maxAttempts, baseRef, pipeline, app command, emulator) and each agent's model/temperature override. Agent `readOnly` is displayed when set; edit it in YAML.
- Browse pipelines and their steps; add, delete, reorder steps, set a per-step model or max-attempts, and add new pipelines. Permissions and attachments are shown read-only (edit those in the YAML).
- When a tab has no file yet, `initialize` writes a starter config (the built-in `implement` pipeline, expanded and ready to edit).

Keys: `↑/↓` move, `enter` edit/expand, `tab` switch tab, `a` add, `d` delete a step, `shift+↑/↓` reorder a step, `t` agent temperature, `m` step max-attempts, `s` save the active tab, `q` quit. Saving re-validates and rewrites clean YAML (comments are not preserved); the dashboard never paints backgrounds, like the run TUIs. Needs an interactive terminal.

## Initializing config files (`archer init`)

`archer config` is interactive; `archer init` is its non-interactive counterpart: it writes a commented starter config and copies the built-in agent prompts so you can customize them in place.

```bash
archer init                # .archer/config.yaml + .archer/agents/*.md in the current repo
archer init --dir ../app   # same, in another repo
archer init --global       # ~/.archer/config.yaml + ~/.archer/agents/*.md
archer init --force        # overwrite existing files
```

The generated config documents every key (commented out) and inlines the built-in `implement` pipeline so it's immediately editable. The copied `agents/*.md` prompts are picked up by name — edit them to override a built-in agent's prompt, or declare a new agent in the config and add its prompt file. Existing files are never overwritten unless `--force` is given. `make install` runs `archer init --global` automatically, so a fresh install ships with a ready-to-edit global config.

## Project Context And Custom Agents

Archer automatically attaches these target-repo files to every phase when they exist:

```text
.archer/rules.md
AGENTS.md
CLAUDE.md
```

Use `.archer/rules.md` for project-specific Archer instructions. It is intentionally the only Archer rules filename to avoid ambiguous precedence. `AGENTS.md` and `CLAUDE.md` are treated as additional repo context.

Built-in agent prompts live as Markdown files under `prompts/`. A project can fully replace a built-in agent prompt with:

```text
.archer/
├── config.yaml          # defaults, agents, pipelines, permissions, attachments
└── agents/
    ├── implementer.md   # overrides the built-in implementer prompt
    ├── pattern-auditor.md
    └── api-reviewer.md  # prompt for a project agent declared in config.yaml
```

When a project override exists, it replaces that agent's built-in prompt completely. Project agents declared in `config.yaml` must bring their prompt at `.archer/agents/<name>.md` (validated at startup). The same convention applies globally: `~/.archer/agents/<name>.md` overrides a built-in for every repo. Prompt precedence is `.archer/agents/<name>.md` (project) > `~/.archer/agents/<name>.md` (global) > the built-in prompt. In all cases Archer still appends its non-replaceable runtime safety guard rails from `prompts/runtime-safety.md`.

## Efficient Attachments

`--file` is repeatable and accepts files or directories. Relative paths are resolved against the target repo.

Archer doesn't paste those contents into the prompt. It sends them to the SDK as `FilePartInput` with `file://` URL, just like OpenCode's `--file`. It does the same internally with `prd.md`, previous reports, and phase diffs.

## Anatomy of a Run

Each invocation creates `~/.archer/runs/<run-id>/`:

```
~/.archer/runs/20260519-103045-x7q2/
├── prd.md
├── metadata.json
├── reports/
│   ├── implementer.md
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   ├── tests.md
│   └── adversarial.md
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

`metadata.json` records the resolved pipeline the run executes plus each step's status, session ID, timing, cost, tokens, and model as the run progresses (written atomically, debounced). On `--resume`, the frozen pipeline is replayed — even if `.archer/config.yaml` changed since — and steps that already wrote their report are restored in the dashboard with their real duration, cost, and session, which can still be opened by clicking the pipeline row.

The run dir is deleted on successful completion unless `--keep-run-dir`. If it fails, it's preserved for inspecting reports, diffs, and logs.

The target repo only sees commits with prefix `archer(<phase>): ...`, made on the current branch. Normal runs leave no CLI files in the project; `archer init` intentionally creates `.archer/config.yaml` when you want project-local configuration.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Structure

```
archer/
├── src/
│   ├── main.ts          # entrypoint
│   ├── cli.ts           # flag parsing
│   ├── runner.ts        # pipeline orchestration
│   ├── opencode.ts      # startup/control via SDK
│   ├── agents.ts        # prompt loading, agent config, bash policy
│   ├── project-context.ts # automatic .archer/rules.md, AGENTS.md, CLAUDE.md discovery
│   ├── permissions.ts   # live permission gate for tool calls that fall outside the allowlist
│   ├── safety-judge.ts  # external AI judge for smart auto-accept (tool-less, fail-closed)
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff, commit, and pre-commit secret scan
│   ├── workspace.ts     # run dir, ~/.archer home (ARCHER_HOME), global config/agents paths
│   ├── runs.ts          # interactive run-history browser (archer runs)
│   ├── runs-tui.ts      # OpenTUI run-history browser rendering
│   ├── metadata.ts      # per-run metadata.json: frozen pipeline + --resume restore
│   ├── config.ts        # config loader/validation, global+project merge, YAML writer
│   ├── config-tui.ts    # interactive config editor (archer config)
│   ├── model-catalog.ts # available-model list via OpenCode SDK, models.dev fallback
│   └── pipeline.ts      # built-in agents/pipeline and pipeline-spec resolution
├── prompts/             # built-in agent prompts and runtime safety guard rails
├── test/                # unit tests for CLI/orchestration
├── package.json
├── tsconfig.json
└── Makefile
```
