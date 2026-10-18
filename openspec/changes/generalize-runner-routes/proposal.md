# Proposal

## Why

`unify-runner-system` gave every harness one execution contract, but choosing *which* harness runs *which* model is still a two-way switch. The core asks "is this `claude-code`, otherwise OpenCode" in about 25 files: model normalization, the advisor/judge/helper routes spelled `claude-code/<model>`, plan dependencies, preflight, prompts, and config validation (`must be "opencode" or "claude-code"`). The runner is also encoded inside the model string, so one model has a different spelling per harness (`opus` or `claude-code/opus` on Claude, `anthropic/claude-opus-5` on OpenCode), and `opencode/<id>` collides with OpenCode Zen's own provider.

A third runner (Codex, `add-codex-runner`) would add a third branch everywhere. More runners will follow, so the routing must be generic before then.

## What Changes

- **The model and the runner are independent.** A model is always written as its provider-owned identity, `provider/model[#variant]` (for example `openai/gpt-5.5`), whichever runner executes it. The runner is a separate `runner` field. The same `model: openai/gpt-5.5` is valid with `runner: opencode` and `runner: codex`.
- **One route shape everywhere.** Each setting that names a model (step `model`, each `models:` entry, `advisor`, the smart judge, the helpers, authoring, `defaults.model`) accepts either a model string, which inherits the runner from its context, or a route `{ runner, model }`. Runner-prefixed strings are removed from the configuration language.
- **Runners are registered, not enumerated.** Each runner contributes one descriptor: identity and labels, capability declaration, model support (which providers it executes, how a model and variant map to its native form, runner-local aliases), authentication schema and effective-auth check, installation probe, and the optional helper-inference, conversation and prompt hooks. Core code never compares runner IDs, and a conformance test enforces that.
- **Runner settings live under the runner.** `runners.<id>.auth` replaces `defaults.claudeAuth`. A route can still override the authentication mode.
- **The run-wide override names its runner.** The CLI gets `--runner <id>` next to `--model <provider/model>`, replacing the `claude-code/<model>` scoping of `--model`.
- **Legacy spellings keep working.** They are read with a deprecation warning that names the new spelling, and frozen plans in `metadata.json` written by earlier versions still resume.

## Capabilities

### New Capabilities

- `runner-routing`: runner-independent model identity, one route shape for every model-bearing setting, a runner registry, and per-runner settings.

### Modified Capabilities

<!-- None: `runner-integration` already requires that adding a harness needs no core branch. This change makes routing meet that requirement rather than redefining it. -->

## Impact

- `src/step-runners.ts` becomes the registry's projection. `src/run-plan.ts`, `src/helper-routes.ts`, `src/runners/plan-dependencies.ts`, `src/advisor.ts`, `src/safety-judge.ts`, `src/commit-message.ts`, `src/worktree.ts`, `src/conversations.ts`, `src/human.ts`, `src/preflight*.ts` and `src/runner.ts` resolve routes through the registry.
- `src/config.ts` (route and `runners:` schema, legacy readers), `src/pipeline.ts` (step resolution, built-in pipelines rewritten in canonical IDs), `src/cli.ts` (`--runner`), `src/metadata.ts` and `src/runners/provenance.ts` (canonical route records plus legacy readers).
- Docs: `configuration.md`, `models.md`, `runners.md`, `pipelines.md`, and `--help`.
- No behavior change for a config that already works. This is the prerequisite for `add-codex-runner`.
