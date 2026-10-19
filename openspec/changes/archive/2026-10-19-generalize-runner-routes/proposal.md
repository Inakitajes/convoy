# Proposal

## Why

`unify-runner-system` gave every harness one execution contract, but choosing *which* harness runs *which* model was still a two-way switch. The core asked "is this `claude-code`, otherwise OpenCode" in about 25 files: model normalization, the advisor/judge/helper routes spelled `claude-code/<model>`, plan dependencies, preflight, provenance, prompts, reviews and config validation (`must be "opencode" or "claude-code"`). Authentication assumed exactly one authenticated runner (`defaults.claudeAuth`, `RunPlan.claude`). The runner was also encoded inside the model string, so one model had a different spelling per harness.

A third runner (Codex, `add-codex-runner`) would have added a third branch everywhere, and more runners will follow.

## What Changes

- **The model and the runner are independent.** A model is written as its provider-owned identity, `provider/model[#variant]` (for example `openai/gpt-5.5`), whichever runner executes it. The runner is the `runner` field. The same `model: openai/gpt-5.5` is valid with `runner: opencode` and `runner: codex`.
- **One route shape.** Each setting that names a model (step `model`, each `models:` entry, `advisor`, the smart judge) accepts a model or a route `{ runner, model }`. A fan-out may mix runners.
- **Runners are registered, not enumerated.** Each runner contributes one descriptor (identity, capabilities, model support, binary, report tool, helper defaults, authentication) plus entries in registration tables for code (composition, helper inference, session openers). Core code never compares runner ids, and a conformance test enforces that.
- **Runner settings live under the runner.** `runners.<id>.auth` configures each CLI runner. `defaults.claudeAuth` still reads. Plans carry one reviewed auth and billing decision per authenticated runner.
- **The runner-qualified shorthand stays.** `codex/gpt-5.5`, `claude-code/opus` are the shorthand where only one string fits (`--model`, `--advisor`, `--smart-model`, older configs), and `--model <runner>/<model>` scopes an override to one runner.
- **Existing configs keep working.** Bare Claude aliases, `claude-code/<model>` strings, `defaults.claudeAuth`, `advisorRoute` and `helperRoutes` resolve as before, and frozen plans resume.

## Capabilities

### New Capabilities

- `runner-routing`: runner-independent model identity, routes for every model-bearing setting, a runner registry, and per-runner settings.

### Modified Capabilities

<!-- None: `runner-integration` already requires that adding a harness needs no core branch. This change makes routing meet it. -->

## Impact

- New `src/runners/descriptors.ts`, `src/runners/helper-inference.ts` and `src/runner-installation.ts`. `src/step-runners.ts` is rebuilt on the descriptors.
- Shared pieces move out of `runners/claude/`: `attempt-bridge.ts`, `attempt-tools.ts`, `loop-guard-service.ts`, `subcommand.ts`, `src/ndjson.ts` and `src/raw-stream-log.ts`.
- Routing consumers become runner-generic:
  - plan building: `run-plan.ts`, `helper-routes.ts`, `plan-dependencies.ts`;
  - helper and advisor calls: `advisor.ts`, `advisor-runtime.ts`, `safety-judge.ts`, `permissions.ts`, `commit-message.ts`, `worktree.ts`, `finalization/compact.ts`;
  - preflight: `preflight.ts`, `preflight-validation.ts`;
  - provenance and review: `provenance.ts`, `run-review.ts`, `review-tui.ts`, `launch-tui.ts`;
  - the engine: `human.ts`, `runner.ts`, `cli.ts`, `worktree-commands.ts`.
- Config (`runners:`, routes), pipeline resolution (per-variant runners), types (`RunnerAuthSelections`, `ReviewedRunnerAuth`).
- Docs: `runners.md`, `models.md`, `configuration.md`, `getting-started.md`, `development.md`, README and `--help`.
