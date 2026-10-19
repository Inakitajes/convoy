# Tasks

## 1. Lock current behavior

- [x] 1.1 Use the existing suite (3812 tests on `main`) as the regression gate for every resolution path (steps, fan-outs, advisors, judge, helpers, auth); verify it stays green at every step, with changed assertions limited to new generic messages and the `runnerAuth` field.
- [x] 1.2 Inventory every runner-id comparison and `claude-code/` prefix use outside the runner adapters; verify each is removed or registered in a table (`test/runner-routing-conformance.test.ts`).

## 2. Registry and types

- [x] 2.1 Introduce `RunnerDescriptor` (`src/runners/descriptors.ts`) and rebuild `stepRunnerFor`, `isStepRunnerId`, `stepRunnerIds`, capability resolution and model labels on it; verify typecheck and the suite.
- [x] 2.2 Move model support into descriptors (runner- versus provider-qualified, provider, aliases, variants) and replace `normalizeStepRunnerModel`, `stepRunnerModel` and `parseModelOverride` with generic versions; verify Claude behavior is unchanged.
- [x] 2.3 Replace the runner branches in routing consumers: plan dependencies, the advisor, the judge, the commit writer, the branch namer, preflight, provenance, the review screens, human gates, the engine's stream log, auth and prompt; move per-runner code into registration tables (helper inference, session openers and recorders, iteration clients, auth probes); verify with the suite.
- [x] 2.4 Add the routing conformance test; verify it detects every comparison spelling and passes on the tree.

## 3. Routes and configuration

- [x] 3.1 Accept `{ runner, model }` routes for fan-out entries, advisors and the judge, normalized to the runner-qualified form the plan stores; verify the routing scenarios (`test/runner-routing.test.ts`).
- [x] 3.2 Resolve each fan-out variant on its own runner, with an inherited model applying only where the runner executes it; verify mixed-runner fan-outs and unique names.
- [x] 3.3 Add `runners.<id>.auth`, merged per runner, with `defaults.claudeAuth` as its legacy reading, and route auth-mode overrides that reuse their runner's credential reference; verify validation and merging.
- [x] 3.4 Carry one reviewed auth and billing decision per authenticating runner in the plan (`RunPlan.runnerAuth`) and run options (`RunOptions.runnerAuth`); verify review, preflight and step auth previews.
- [x] 3.5 Keep legacy spellings and frozen plans resolving as before; verify with the existing route, config and resume tests.
- [x] 3.6 Resolve a runner-less route auth mode against the runner the route really uses (the advisor model's runner, else Claude; the authoring harness), never `defaults.runner`; verify OpenCode and Codex run-wide runners.

## 4. CLI, review and docs

- [x] 4.1 Scope `--model` by the runner-qualified shorthand and name unaffected steps; verify the mixed-plan override scenario.
- [x] 4.2 Show each CLI runner's route in launch review and the review TUI, and a CLI step's model as `<runner>/<model>`; verify review tests.
- [x] 4.3 Document one model spelling, routes, inheritance and `runners:` in `runners.md`, `models.md`, `configuration.md`, `getting-started.md`, `development.md`, README and `--help`.
