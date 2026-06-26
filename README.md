# archer

Sequential [OpenCode](https://opencode.ai) agent pipeline for implementing features on software repos. It works with Flutter, web, backend, CLI, and mixed projects by detecting the repo's existing stack and conventions. Takes a PRD, runs agents in chain, and leaves one commit per step.

Pipelines are data, not code: archer ships a built-in `default` pipeline, and a project can define its own — any number of steps, its own agents, its own models, with `human-review` gates anywhere — in `.archer/config.yaml`.

Archer is written in Bun + TypeScript and uses `@opencode-ai/sdk` to control OpenCode. The SDK starts/controls the OpenCode server; Archer no longer manually calls `opencode run` nor parses stdout.

## The default pipeline

```
PRD ──► implementer ──► human-review ──► patterns ──► security ──► design ──► tests ──► adversarial
         │                                │            │            │          │         │
         └────────────────────────────────┴────────────┴────────────┴──────────┴─────────┘
                                                              commit per step
```

| Step | Agent | Model | What it does |
|---|---|---|---|
| `implementer` | `implementer` | `openai/gpt-5.5#xhigh` | Implements the feature respecting repo patterns |
| `human-review` | — | interactive checkpoint | Runs the app, waits for approval, or hands control to OpenCode for manual iteration |
| `patterns` | `pattern-auditor` | `openai/gpt-5.5#xhigh` | Refactors without changing behavior, aligns with the rest of the code |
| `security` | `security-auditor` | `openai/gpt-5.5#xhigh` | Audits and fixes security issues |
| `design` | `design-polisher` | `anthropic/claude-opus-4-7` | Polishes UI following the repo's design system |
| `tests` | `test-engineer` | `openai/gpt-5.5#xhigh` | Automated tests + relevant E2E/integration coverage |
| `adversarial` | `adversarial-reviewer` | `anthropic/claude-opus-4-7` | Final adversarial review before PR creation |

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

To use different providers, authenticate them in OpenCode and select models as `provider/model`. Archer defaults to `openai/gpt-5.5` with variant `xhigh` for non-design phases, and `anthropic/claude-opus-4-7` for design and adversarial review.

## Installation

```bash
git clone <this-repo> archer
cd archer
bun install
make install
```

This leaves `archer` in `~/.local/bin/archer`. Make sure it's in your `PATH`.

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

# disable the post-implementer manual checkpoint
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
# breakdown. ↑/↓ select, [enter] resume, [s]ummary/reports overlay, subshell
# in the run [d]ir under ~/.archer/runs (exit to return), [q]uit.
# Pass a run ID to open the browser with that run preselected.
# Without a TTY (pipes/CI) it falls back to a plain listing.
archer runs
archer runs 20260519-103045-x7q2

# view and edit the global (~/.archer) and current project config in a TUI:
# two tabs (Global / Project), pick models with autocomplete, edit pipelines
# and steps, or initialize a starter config when none exists.
archer config

# auto-allow ask-level permissions (the hard denylist still applies)
archer --prompt-file prd.md --yolo

# preserve run dir after completion
archer --prompt-file prd.md --keep-run-dir

# change the base branch used to calculate diffs between phases
# (the ref is validated at startup; repos without a local main need this)
archer --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

In interactive terminals, Archer shows a full-screen OpenTUI dashboard: pipeline progress with per-phase duration and cost, plus an activity panel headed by a compact summary of the active session (current tool/thinking/writing, the agent's todo list, files changed, step count, tokens, cost) above a color-coded event feed. The dashboard never paints backgrounds: the canvas is your terminal's own background and panels are delineated by borders alone, derived as subtle elevations of the terminal's reported background color, with dark or light accents picked by its brightness (and a neutral fallback when the terminal doesn't answer); floating modals repaint the reported color exactly to mask the content beneath them. It follows live theme changes. Press `o`, or click the footer, to open the active OpenCode session in a new terminal window attached to Archer's running OpenCode server — clicking any pipeline row opens that phase's session, including phases that already finished. Ghostty is preferred when installed; Terminal.app is the fallback (`ARCHER_TERMINAL=ghostty|terminal` forces a backend). Press `Shift+Tab` to toggle auto-accept (see the permission gate below). Press `Ctrl+C` once to abort the active OpenCode session and shut down Archer cleanly; press it again to force exit if cleanup hangs. The dashboard suspends for the whole `human-review` checkpoint — the prompts, your app command's output, and interactive OpenCode iterations own the terminal — and resumes when the gate finishes. Use `--no-tui` to fall back to plain logs.

When the run ends (success or failure), the dashboard doesn't close: it becomes a finish screen presenting the work done. The pipeline turns into a phase browser — move with `j`/`k` (or click a phase) to inspect each phase's outcome, duration, model, cost, diff, and its report (`PgUp`/`PgDn` scroll long reports). Press `o` to open the selected phase's OpenCode session in a new terminal window (the server stays alive while the screen is up), and `g` to open lazygit in the target repo as a subshell — `git log --graph --decorate --stat` is the fallback when lazygit isn't installed. Press `q`, `Esc`, or `Ctrl+C` to close; only then does Archer clean up the run dir and stop its OpenCode server. Failed runs pre-select the failed phase and show its error.

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

### Auto-accept (`--yolo` / `Shift+Tab`)

`--yolo` starts the run with auto-accept enabled: every permission request that would normally *ask* is allowed automatically (replied as "once") and logged to the activity feed. In the dashboard, `Shift+Tab` toggles auto-accept at any time — enabling it also resolves any prompts already queued. The footer always shows the current state. The hard denylist is enforced by OpenCode itself and is never relaxed: denied commands are rejected before they ever reach the gate, with or without `--yolo`.

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

# Project agents: the prompt lives at .archer/agents/<name>.md (required).
# Naming a built-in agent here overrides its model/temperature instead.
agents:
  api-reviewer:
    description: Reviews public API consistency
    model: anthropic/claude-opus-4-7
    temperature: 0.1

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
- **Project pipelines shadow built-ins**: defining `pipelines.default` replaces the built-in default.
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
- Edit `defaults` (model, interactiveModel, maxAttempts, baseRef, pipeline, app command, emulator) and each agent's model/temperature override.
- Browse pipelines and their steps; add, delete, reorder steps, set a per-step model or max-attempts, and add new pipelines. Permissions and attachments are shown read-only (edit those in the YAML).
- When a tab has no file yet, `initialize` writes a starter config (the built-in `default` pipeline, expanded and ready to edit).

Keys: `↑/↓` move, `enter` edit/expand, `tab` switch tab, `a` add, `d` delete a step, `shift+↑/↓` reorder a step, `t` agent temperature, `m` step max-attempts, `s` save the active tab, `q` quit. Saving re-validates and rewrites clean YAML (comments are not preserved); the dashboard never paints backgrounds, like the run TUIs. Needs an interactive terminal.

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

When a project override exists, it replaces that agent's built-in prompt completely. Project agents declared in `config.yaml` must bring their prompt at `.archer/agents/<name>.md` (validated at startup). In both cases Archer still appends its non-replaceable runtime safety guard rails from `prompts/runtime-safety.md`.

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
│   ├── human-review.md
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

The target repo only sees commits with prefix `archer(<phase>): ...`, made on the current branch. No CLI files are left in the project.

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
