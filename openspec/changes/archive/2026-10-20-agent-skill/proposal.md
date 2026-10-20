# Proposal

## Why

An agent session (Claude Code, OpenCode, Codex) can already launch Convoy headless, but it can't use it well. A launch blocks until the run ends, which outlives every shell tool's timeout. `convoy runs <id>` prints text meant for people. A permission request can only be answered from the TUI. Running a pipeline that isn't in the config means editing the operator's config. And nothing tells the agent what Convoy can do or how to drive it, so every session rediscovers it from `--help`.

## What Changes

- `--detach`: start the coordinator, print `run <id> started`, and return while the run continues. Implies `--no-tui`, `--no-confirm`, and no human steps.
- `convoy runs <id> --json` (and `convoy runs --json`): the run as data, with a collapsed `state`, phases, cost, the pending request, goal, summary and report paths, and the detached coordinator's log path.
- `convoy runs <id> --wait [--timeout <duration>]`: block until the run ends, stops at a gate, or the timeout passes, with exit codes 0 (completed), 1 (ended otherwise), 2 (still running), 3 (waiting for an answer).
- `convoy runs <id> approve <request> [--always] | deny <request> | abort`: answer a detached run as its controller for one request.
- `--pipeline-file <path>`: run a pipeline defined in its own YAML file, validated like a config pipeline and frozen into the run.
- `convoy pipelines [--json]` and `convoy pipelines show <name> | --pipeline-file <path>`: the catalog of runnable pipelines and agents, and one pipeline's resolved steps.
- `convoy skill install|uninstall|show`: an agent skill (`skills/convoy/SKILL.md` plus a pipeline-file reference), embedded in the binary and installed into the global skills directory of Claude Code, OpenCode, and Codex.

## Capabilities

### New Capabilities

- `agent-cli`: the machine-facing launch, status, wait, answer, and catalog surface.
- `agent-skill`: the embedded skill and its installer.

### Modified Capabilities

<!-- None: interactive launches, the runs browser, and config pipelines behave as before. -->

## Impact

- New: `src/runs-command.ts`, `src/pipelines-command.ts`, `src/skill-install.ts`, `skills/convoy/`.
- Changed: `src/cli.ts` (flags, commands, help), `src/config.ts` (`parsePipelineFile`, `loadPipelineFile`), `src/runs.ts` (`loadRun`, `probeRunPending`), `src/types.ts` (`RunOptions.detach`).
- Docs: `docs/agents.md` (new), `docs/running.md`, `docs/pipelines.md`, `docs/development.md`, `docs/README.md`, `README.md`.
