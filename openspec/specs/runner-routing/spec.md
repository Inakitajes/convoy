# runner-routing Specification

## Purpose
Choose the harness that executes each model through runner-independent routes, so models keep one spelling and adding a runner needs no change to routing, validation, preflight, provenance or prompts.

## Requirements

### Requirement: A model has one spelling whatever runner executes it

Every model-bearing setting SHALL accept a model by its provider-owned identity, `provider/model[#variant]`. The runner SHALL be chosen by a separate `runner` field or route. Each runner SHALL declare which models it executes and how a model and its variant map to the runner's native form. A model that a runner cannot execute SHALL be refused at validation with the runner, the model, and where the runner was inherited from. It SHALL NOT be translated to another model.

#### Scenario: One model on two runners
- **WHEN** one step sets `runner: opencode` and another sets `runner: codex`, both with `model: openai/gpt-5.5`
- **THEN** both steps validate, OpenCode runs `openai/gpt-5.5`, and Codex runs its native `gpt-5.5`

#### Scenario: A runner meets a model it cannot execute
- **WHEN** a step on `runner: codex` names `model: anthropic/claude-opus-5`
- **THEN** validation fails, names `codex` and the model, and states which models Codex executes

#### Scenario: A variant the runner cannot honor
- **WHEN** a Codex model carries `#turbo`, or a Claude model carries any `#variant`
- **THEN** validation fails instead of dropping the variant

### Requirement: Every model-bearing setting accepts a route

A step's `model`, each `models:` entry, every `advisor`, and `defaults.autoAcceptJudgeModel` SHALL accept either a model or a route `{ runner, model }`. A step's runner SHALL be its own `runner`, else the runner its `model` route names, else `defaults.runner`, else OpenCode. A `model` route that names a different runner than the step's own `runner` SHALL be refused. Its model and plain fan-out entries SHALL be read in that runner's namespace. A model the step only inherits (agent `model`, `defaults.model`) SHALL apply only where the runner executes it. A plain advisor or judge model SHALL keep consulting through OpenCode. Convoy SHALL NOT infer a runner from a model's provider. The resolved runner and model SHALL be frozen in the plan and shown in review.

#### Scenario: An advisor on a different runner
- **WHEN** a Codex step sets `advisor: { runner: claude-code, model: anthropic/opus }`
- **THEN** the step executes on Codex and consults through Claude, each under its own runner's authentication

#### Scenario: A fan-out that mixes runners
- **WHEN** a step on `runner: codex` lists `openai/gpt-5.5`, `{ runner: claude-code, model: anthropic/sonnet }` and `{ runner: opencode, model: openai/gpt-5.5 }` under `models:`
- **THEN** one attempt runs on each runner, and every phase name is unique

#### Scenario: An inherited runner is not guessed
- **WHEN** `defaults.runner: codex` and a step without a runner names `anthropic/claude-opus-5`
- **THEN** validation fails, stating that the runner came from `defaults.runner`, instead of switching the step to another runner

#### Scenario: A plan on one CLI runner inherits it for helpers
- **WHEN** every step runs on Codex and no judge or commit writer is configured
- **THEN** the judge and the commit writer run on Codex, and no OpenCode is needed

### Requirement: Runners are described by registered descriptors

Each runner SHALL be described by one descriptor: its identity, its capability declaration, its model support, its installation binary, its report-tool name, its helper defaults, and whether it authenticates. Per-runner code SHALL be registered in tables keyed by runner id. Configuration validation, plan dependencies, preflight, provenance, review and prompt composition SHALL read runner behavior from the descriptors and tables. Core modules SHALL NOT compare runner names.

#### Scenario: A runner literal outside its boundary
- **WHEN** a core module compares against a runner id literal
- **THEN** the routing conformance test fails

#### Scenario: An unknown runner
- **WHEN** a config names `runner: gemini`
- **THEN** validation fails and lists the registered runners

### Requirement: Runner settings live under the runner

Settings for a runner that authenticates SHALL be configured under `runners.<id>.auth`. Global and project settings SHALL merge per runner. A route MAY override its runner's authentication mode. The override SHALL apply only to that runner: an advisor on another runner SHALL keep its own runner's authentication. It SHALL reuse that runner's credential reference and SHALL NOT embed a credential value. Each plan SHALL carry one reviewed authentication and billing decision for every authenticating runner it uses: a step, an advisor, the judge, or the commit writer.

#### Scenario: Two runners with different authentication
- **WHEN** `runners.claude-code.auth` selects a subscription and `runners.codex.auth` selects an API key
- **THEN** review shows both routes, and each attempt, advisor and helper runs under its own runner's authentication

#### Scenario: An advisor route's authentication on a mixed plan
- **WHEN** `advisorRoute` selects Codex with an API key and a step's own advisor runs on Claude
- **THEN** the Claude advisor consults under Claude's authentication, never the Codex route's key

#### Scenario: An advisor route's authentication with no runner
- **WHEN** `advisorRoute.authMode` is set without `advisorRoute.runner`
- **THEN** it applies to the runner the advisor model is qualified for, else Claude, whatever `defaults.runner` is

#### Scenario: A runner that authenticates through its own configuration
- **WHEN** a config sets `runners.opencode.auth`
- **THEN** validation fails, because OpenCode authenticates through its own provider configuration

### Requirement: The run-wide override names its runner explicitly

An unqualified `--model` SHALL override steps on provider-qualified runners (OpenCode). A runner-qualified `--model <runner>/<model>` SHALL override only that runner's steps. Review SHALL name the steps an override did not reach.

#### Scenario: Override on a mixed plan
- **WHEN** a plan has OpenCode and Codex steps and the run is started with `--model codex/gpt-6.1-sol#xhigh`
- **THEN** the Codex steps use that model and effort, and the OpenCode steps keep theirs

### Requirement: Existing configuration keeps working

Configuration written before this change SHALL resolve to the same runner, model and authentication as before. This covers `claude-code/<model>` strings, bare Claude aliases, `defaults.claudeAuth`, `advisorRoute`, `helperRoutes`, `autoAcceptJudgeModel`, `branchNameModel` and `commitMessageModel`. Frozen plans and attempt records written by earlier versions SHALL resume with their recorded runner, model, session and authentication.

#### Scenario: An unchanged config
- **WHEN** a config from v0.11 is loaded
- **THEN** every resolved step, advisor, judge and helper route equals its previous resolution
