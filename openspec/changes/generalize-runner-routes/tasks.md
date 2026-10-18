# Tasks

## 1. Lock current behavior

- [ ] 1.1 Add a golden test that resolves every built-in pipeline and the repo's config fixtures (steps, fan-outs, advisors, judge, helpers, authoring, auth) to a normalized route list; verify it passes unchanged on `main` before any refactor.
- [ ] 1.2 Inventory every runner-ID comparison and `claude-code/` prefix use outside `src/runners/<id>/**`; verify each one maps to a task below.

## 2. Registry and types

- [ ] 2.1 Introduce `RunnerDescriptor`, the registry, and `RunnerId` as a registry-checked string; rebuild `stepRunnerFor`, `isStepRunnerId`, `stepRunnerIds` and capability resolution on it; verify typecheck and the existing suite pass with no behavior change.
- [ ] 2.2 Move model support into descriptors (`accepts`, aliases, variant mapping, default model) for OpenCode and Claude; replace `normalizeStepRunnerModel` and `stepRunnerModel`; verify the golden test is unchanged.
- [ ] 2.3 Move the installation probe, the effective-auth check, helper inference, conversation support and the prompt's report-tool name behind the descriptor; remove the `runnerId === "claude-code"` branches in `runner.ts`, `run-plan.ts`, `plan-dependencies.ts`, `advisor.ts`, `safety-judge.ts`, `commit-message.ts`, `worktree.ts`, `conversations.ts` and `human.ts`; verify the golden test is unchanged.
- [ ] 2.4 Extend the dependency-direction test to fail on runner-ID literals outside the allowed boundaries; verify it fails on a planted literal and passes on the tree.

## 3. Routes and configuration

- [ ] 3.1 Add the `ModelRoute` parser and validator and use it for step `model`, `models:` entries, `advisor`, `defaults.model`, `defaults.judge`, `defaults.helpers.*` and `defaults.authoring`; implement D3 inheritance with errors that name the runner's source; verify the scenarios in `specs/runner-routing/spec.md`.
- [ ] 3.2 Replace the fake `providerID: "claude-code"` advisor marker with a resolved route on `AgentStep` and the plan; verify advisor dependencies and consultation routing for every runner pair.
- [ ] 3.3 Add `runners.<id>` with descriptor-parsed `auth`; keep route-level `authMode`; verify the per-runner auth scenario and that no credential value is accepted.
- [ ] 3.4 Make fan-out phase names unique per runner (D8); verify the same-model, two-runner scenario.
- [ ] 3.5 Implement the legacy readers and deprecation notices (D7), including the pre-change advisor default of `opencode`; verify the golden test resolves legacy fixtures identically and old `metadata.json` fixtures resume.
- [ ] 3.6 Rewrite built-in pipelines and the `convoy init` template in canonical IDs and routes; verify the golden test is unchanged.

## 4. CLI, review and docs

- [ ] 4.1 Add `--runner` and canonical `--model` semantics (D6), reading `--model claude-code/<m>` as legacy; verify the mixed-plan override scenario and that review lists steps the override did not reach.
- [ ] 4.2 Show `model · runner` for every route in launch review, the dashboard and `SUMMARY.md`; verify snapshots.
- [ ] 4.3 Update `configuration.md`, `models.md`, `runners.md`, `pipelines.md` and `--help` with the route model, inheritance, `runners:` and a legacy-to-new table; verify every documented example parses in a doc test.
