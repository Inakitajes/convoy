# Spec Delta

## Purpose

Choose the harness that executes each model through one runner-independent route, so models keep one spelling and adding a runner needs no change to routing, validation, preflight or prompts.

## ADDED Requirements

### Requirement: A model has one spelling whatever runner executes it

Every model-bearing setting SHALL name a model by its provider-owned identity, `provider/model[#variant]`. The runner SHALL be chosen by a separate `runner` field and SHALL NOT be encoded in the model string. Each runner SHALL declare which models it executes and how a model and its variant map to the runner's native form. A model that a runner cannot execute SHALL be refused at validation with the runner, the model, and where the runner was inherited from. It SHALL NOT be translated to another model.

#### Scenario: One model on two runners
- **WHEN** one step sets `runner: opencode` and another sets `runner: codex`, both with `model: openai/gpt-5.5`
- **THEN** both steps validate, and review shows the same model with each step's runner

#### Scenario: A runner meets a model it cannot execute
- **WHEN** a step on `runner: claude-code` names `model: openai/gpt-5.5`
- **THEN** validation fails, names `claude-code` and the model, and suggests a model it executes or a different runner on the step

#### Scenario: A runner-local alias on another runner
- **WHEN** a step on `runner: opencode` names `anthropic/opus`, an alias only `claude-code` declares
- **THEN** validation fails and names the runners that accept the alias

#### Scenario: A variant the runner cannot honor
- **WHEN** a model carries `#xhigh` and the step's runner neither maps nor accepts that variant
- **THEN** validation fails instead of dropping the variant

### Requirement: Every model-bearing setting accepts the same route

A step's `model`, each `models:` entry, `advisor`, `defaults.model`, the smart judge, the helper routes and authoring SHALL accept either a model string or a route `{ runner, model }`. A route's runner SHALL be its own `runner`, else its enclosing context's runner (the step for its model, advisor and fan-out entries), else `defaults.runner`, else `opencode`. Convoy SHALL NOT infer a runner from a model's provider. The resolved runner and model SHALL be frozen in the plan and shown in review.

#### Scenario: An advisor on a different runner
- **WHEN** a Codex step sets `advisor: { runner: claude-code, model: anthropic/opus }`
- **THEN** the step executes on Codex and consults through Claude, with each route's own authentication

#### Scenario: A fan-out that mixes runners
- **WHEN** `models:` lists `openai/gpt-5.5` and `{ runner: claude-code, model: anthropic/sonnet }` on a step with `runner: codex`
- **THEN** one attempt runs on each runner, and the phase names stay unique

#### Scenario: The same model fanned out on two runners
- **WHEN** `models:` lists `openai/gpt-5.5` and `{ runner: opencode, model: openai/gpt-5.5 }`
- **THEN** both attempts run, and their phase names differ by runner

#### Scenario: An inherited runner is not guessed
- **WHEN** `defaults.runner: claude-code` and a step without a runner names `openai/gpt-5.5`
- **THEN** validation fails and states the runner came from `defaults.runner`, rather than switching the step to another runner

### Requirement: Runners are described by registered descriptors

Each runner SHALL be registered by one descriptor that carries its identity, its capability declaration, its model support, its authentication schema and effective-auth check, its installation probe, and its optional helper-inference, conversation and prompt hooks. Configuration validation, plan dependencies, preflight, provenance and prompt composition SHALL read runner behavior only from the registry. Code outside a runner's adapter directory, the registry and the built-in pipeline definitions SHALL NOT compare runner identifiers.

#### Scenario: Registering a new runner
- **WHEN** a test registers a fake runner descriptor and adapter
- **THEN** a pipeline naming it validates, preflights, runs, records provenance and resumes, without an edit to routing or config code

#### Scenario: A runner literal outside its boundary
- **WHEN** a core module compares against a runner ID literal
- **THEN** the dependency-direction conformance test fails

#### Scenario: An unknown runner
- **WHEN** a config names `runner: nonexistent`
- **THEN** validation fails and lists the registered runners

### Requirement: Runner settings live under the runner

Runner-specific settings, starting with authentication, SHALL be configured under `runners.<id>` and validated by that runner's descriptor. A route MAY override its runner's authentication mode. It SHALL reuse that runner's credential reference and SHALL NOT embed a credential value.

#### Scenario: Two runners with different authentication
- **WHEN** `runners.claude-code.auth` selects a subscription and `runners.codex.auth` selects an API key
- **THEN** each attempt runs under its own runner's authentication, and provenance records each mode and credential reference

### Requirement: The run-wide override names its runner explicitly

`--model` SHALL take a canonical model, and `--runner` SHALL name a registered runner. With both, every agent step SHALL run on that runner and model. With only `--model`, steps whose runner accepts the model SHALL use it, and the rest SHALL keep their model and be listed in review. With only `--runner`, steps SHALL move to that runner, and validation SHALL fail on any model it rejects.

#### Scenario: Override on a mixed plan
- **WHEN** a plan has OpenCode and Claude steps and the run is started with `--model openai/gpt-5.5`
- **THEN** the OpenCode steps use that model, the Claude steps keep theirs, and review lists the steps the override did not reach

### Requirement: Legacy spellings keep working

Configuration written before this change, including `claude-code/<model>` strings, bare Claude aliases, `defaults.claudeAuth`, `advisorRoute`, `helperRoutes`, `autoAcceptJudgeModel`, `branchNameModel` and `commitMessageModel`, SHALL resolve to the same runner, model and authentication as before. Each SHALL report one deprecation notice naming its replacement. Convoy SHALL NOT rewrite the operator's files. Frozen plans and attempt records written by earlier versions SHALL resume with their recorded runner, model, session and authentication.

#### Scenario: An unchanged legacy config
- **WHEN** a config from v0.11 is loaded
- **THEN** every resolved step, advisor, judge and helper route equals its previous resolution, and deprecation notices name the new keys

#### Scenario: Resuming an old run
- **WHEN** `convoy --resume` reopens a run frozen with `providerID: "claude-code"` advisor routes
- **THEN** the run resumes on the recorded runners without asking for a new selection
