# Design

## Context

See `proposal.md`. The execution port was already runner-neutral (`src/runners/contracts.ts`, `declarations.ts`, `compose.ts`). The routing layer around it was not:

- `normalizeStepRunnerModel`, `stepRunnerModel` and `parseModelOverride` (`src/step-runners.ts`) branched on `claude-code` versus OpenCode.
- Claude routes were a string prefix (`claude-code/<model>`) parsed separately in `helper-routes.ts`, `run-plan.ts`, `plan-dependencies.ts`, `config.ts`, `advisor.ts` and `safety-judge.ts`, and helpers called the Claude CLI directly.
- `runner.ts` had Claude-only branches for the stream log path, the auth field, the session-directory record and the `write_report` tool name. Preflight, provenance and the review screens checked `=== "claude-code"`.
- `RunOptions.claudeAuth` and `RunPlan.claude` assumed exactly one authenticated runner.
- `modelRouting` already recovered a provider-owned logical identity (`logicalModel`). That logical form is the canonical identity this change adopts.

## Goals / Non-Goals

**Goals:**

- One spelling per model, independent of the runner. The runner is chosen by a field, not by the model string.
- Adding a runner means registering one descriptor, its adapter, and its entries in the registration tables, with no edit to routing, config validation, preflight, provenance or prompts.
- Existing configs, frozen plans and resumed runs keep working.

**Non-Goals:**

- Inferring a runner from a model's provider. `openai/*` can run on OpenCode or on Codex, so the choice stays explicit.
- Cross-runner model translation. An `anthropic/*` model on Codex is an error, not a guessed equivalent.
- Changing OpenCode gateway semantics. `modelRouting` still applies, and only to OpenCode.
- Generalizing authoring conversations. They stay harness-specific (OpenCode, Claude), because a conversation must be linked by an id the harness lets Convoy choose or discover.

## Decisions

### D1. Canonical model identity is `provider/model[#variant]`

A model reference is the provider-owned identity. Each runner's descriptor declares which models it executes and how a model maps to its native form:

| Runner | Executes | Native model | `#variant` |
|---|---|---|---|
| `opencode` | any configured provider (gateways apply) | `provider/model#variant` unchanged | provider variant |
| `claude-code` | `anthropic/*`, plus the CLI aliases `opus`, `sonnet`, `haiku` | the model without the provider | refused (as before) |
| `codex` | `openai/*` | the model without the provider | reasoning effort (`minimal`…`xhigh`) |

A bare model ID or alias is still accepted on a runner-qualified runner, so existing Claude configs (`model: opus`) keep working.

### D2. Routes are a runner plus a model; a runner-qualified string is the shorthand

Every model-bearing setting (step `model`, each `models:` entry, step/agent/defaults `advisor`, `defaults.autoAcceptJudgeModel`) accepts a model string or a route `{ runner, model }`. Config parsing normalizes a route to one internal form that the plan and every downstream consumer read:

- On a runner-qualified runner (Claude, Codex): `<runner>/<native>[#variant]`, for example `codex/gpt-5.5#high`.
- On a provider-qualified runner (OpenCode): `provider/model[#variant]`. In a fan-out entry it is written `opencode/<provider>/<model>`, so the entry keeps its runner instead of inheriting the step's.

The runner-qualified string is also the shorthand where only one string fits: `--model`, `--advisor`, `--smart-model`, and older configs. It is not deprecated. It is the same form the plan stores, and it is unambiguous because a runner-qualified runner's id is never a provider. `opencode/<id>` alone stays an OpenCode Zen model.

This keeps the plan's types (strings) and every frozen plan unchanged, while the configuration language gains the runner field the change asks for.

### D3. Inheritance is explicit and fails loudly

- A step's runner is its `runner`, else `defaults.runner`, else OpenCode. Its model and its plain fan-out entries are read in that runner's namespace.
- A model the step inherits (agent `model`, `defaults.model`) applies when the step's runner executes it. Otherwise the runner keeps its own default, as Claude steps always did.
- A plain advisor or judge model consults through OpenCode, which is today's meaning, so existing configs do not change. `defaults.advisorRoute.runner` qualifies the default advisor, and a route consults its runner.
- A step model its runner cannot execute fails validation. The error names the runner, where the runner came from (`defaults.runner` or the step), and how to fix it.

### D4. Runner descriptors are the only place a runner is described

`src/runners/descriptors.ts` holds one descriptor per runner. A descriptor declares:

- `id`, `displayName` and `sessionName`;
- the capability declaration;
- model support: whether the runner is runner-qualified, its provider, aliases, variants and an error hint;
- `binary` and `installHint`;
- `reportTool`;
- the default helper and advisor models;
- `authenticates`;
- `conversationsUnavailable`.

`step-runners.ts`, capabilities, config validation, plan dependencies, preflight, provenance, review and prompt composition read the descriptor. Per-runner behavior that is code, not data, lives in tables keyed by runner id:

- the composition (attempt and service binding);
- helper inference (`src/runners/helper-inference.ts`);
- session-window openers and recorders;
- human-gate iteration clients;
- preflight auth probes.

`test/runner-routing-conformance.test.ts` fails when a core module compares a runner name. Authoring-conversation harness checks and CLI subcommand words are excluded.

### D5. Runner settings live under `runners.<id>`

`runners.<id>.auth` (`authMode`, `credentialRef`, `billingPolicy`) configures each runner that authenticates. Global and project settings merge per runner. `defaults.claudeAuth` is read as `runners.claude-code.auth` when that is unset. A route's `authMode` override (`advisorRoute`, `authoring`) reuses its own runner's credential reference. A runner-less `advisorRoute` is for its advisor model's qualified runner, else Claude, never `defaults.runner`; `authoring` is for the harness authoring opens. An `auth` block merges as a unit: a project block replaces the global one whole. `RunOptions.runnerAuth` and `RunPlan.runnerAuth` carry one reviewed auth and billing decision per authenticated runner the plan uses.

### D6. The run-wide override is scoped by the shorthand

`--model <runner>/<model>` overrides only that runner's steps. An unqualified `--model` overrides provider-qualified (OpenCode) steps, and review names the steps an override did not reach. A separate `--runner` flag was considered and left out: it would move every step to another runner at once, which the per-step `runner` field and `defaults.runner` already express without a new flag.

### D7. Fan-out names stay unique across runners

A fan-out entry on the step's own runner keeps its plain slug (`clean-code__opus`, unchanged). An entry on another runner is slugged with its runner (`bug-auditor__claude-code-sonnet`), so the same model on two runners never collides.

## Risks / Trade-offs

- **Wide, mechanical diff.** The existing suite was the regression gate: no existing test changed meaning. The few that changed name the new generic messages or the new `runnerAuth` field, and new tests cover routing, configuration and the conformance check.
- **Aliases are a soft exception to "one spelling".** They are accepted because version pinning in built-in pipelines costs more. A model still never encodes its runner except in the shorthand.
- **Plain advisors stay on OpenCode.** It would be more uniform for a plain advisor to inherit the step's runner, but that would silently change where existing configs consult. A route makes the choice explicit instead.
