# archer

Sequential [OpenCode](https://opencode.ai) agent pipeline for implementing features on a Flutter repo. Takes a PRD, runs 5 agents in chain, and leaves one commit per phase.

Archer is written in Bun + TypeScript and uses `@opencode-ai/sdk` to control OpenCode. The SDK starts/controls the OpenCode server; Archer no longer manually calls `opencode run` nor parses stdout.

## The Pipeline

```
PRD ──► implementer ──► pattern-auditor ──► security-auditor ──► design-polisher ──► test-engineer
         │              │                    │                    │                  │
         └──────────────┴────────────────────┴────────────────────┴──────────────────┘
                                 commit per phase
```

| Phase | Model | What it does |
|---|---|---|
| `implementer` | `claude-opus-4-7` | Implements the feature respecting repo patterns |
| `patterns` | `claude-opus-4-7` | Refactors without changing behavior, aligns with the rest of the code |
| `security` | `claude-sonnet-4-6` | Audits and fixes security issues |
| `design` | `claude-sonnet-4-6` | Polishes UI following the repo's design system |
| `tests` | `claude-sonnet-4-6` | Unit/widget tests green + Maestro flows |

## Requirements

- Bun 1.0+
- `opencode` installed and authenticated (`opencode auth login`)
- `git`

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
archer --prompt-file prd.md --file lib/features/onboarding --file test/onboarding_test.dart

# only one phase
archer --prompt-file prd.md --only implementer

# skip phases
archer --prompt-file prd.md --skip security,design

# force a different model for all phases
archer --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# resume a failed run
archer --resume 20260519-103045-x7q2

# preserve run dir after completion
archer --prompt-file prd.md --keep-run-dir

# change the base branch used to calculate diffs between phases
archer --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

## Efficient Attachments

`--file` is repeatable and accepts files or directories. Relative paths are resolved against the target repo.

Archer doesn't paste those contents into the prompt. It sends them to the SDK as `FilePartInput` with `file://` URL, just like OpenCode's `--file`. It does the same internally with `prd.md`, previous reports, and phase diffs.

## Anatomy of a Run

Each invocation creates `~/.archer/runs/<run-id>/`:

```
~/.archer/runs/20260519-103045-x7q2/
├── prd.md
├── reports/
│   ├── implementer.md
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   └── tests.md
├── diffs/
│   ├── patterns.pre.diff
│   ├── security.pre.diff
│   ├── design.pre.diff
│   └── tests.pre.diff
├── logs/
│   ├── implementer.1.json
│   └── ...
└── SUMMARY.md
```

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
│   ├── agents.ts        # inline prompts and agent config
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff and commit
│   ├── workspace.ts     # run dir
│   └── phases.ts        # declarative phase definition
├── test/                # unit tests for CLI/orchestration
├── package.json
├── tsconfig.json
└── Makefile
```
