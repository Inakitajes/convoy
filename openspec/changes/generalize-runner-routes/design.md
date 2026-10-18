# Design

## Context

See `proposal.md`. The execution port is already runner-neutral (`src/runners/contracts.ts`, `declarations.ts`, `compose.ts`). The routing layer around it is not:

- `normalizeStepRunnerModel`, `stepRunnerModel` and `parseModelOverride` (`src/step-runners.ts`) branch on `claude-code` against OpenCode.
- Claude routes are a string prefix (`claude-code/<model>`), parsed separately in `helper-routes.ts`, `run-plan.ts`, `plan-dependencies.ts` and `config.ts` (`advisorRoute` re-prefixes the advisor). A resolved Claude advisor is marked by the fake provider ID `providerID === "claude-code"`.
- `runner.ts` has Claude-only branches for the stream log path, the auth field and the `write_report` tool name in the prompt.
- `--model` overrides OpenCode steps only, unless the value is prefixed `claude-code/`. `opencode/<id>` is ambiguous with OpenCode Zen and needs a special case.
- `modelRouting` (the gateways `direct`, `openrouter`, `nitro`, `vercel`) already recovers a provider-owned logical identity (`logicalModel`). That logical form is the canonical identity this change adopts.

## Goals / Non-Goals

**Goals:**

- One spelling per model, independent of the runner. The runner is chosen by a field, never by the model string.
- Adding a runner means registering one descriptor and an adapter, with no edit to routing, config validation, preflight or prompts.
- Existing configs, frozen plans and resumed runs keep working.

**Non-Goals:**

- Inferring a runner from a model's provider. `openai/*` can run on OpenCode or on Codex, so the choice stays explicit.
- Cross-runner model translation. An `anthropic/*` model on Codex is an error, not a guessed equivalent.
- Changing OpenCode gateway semantics. `modelRouting` still applies, and only to the OpenCode runner.

## Decisions

### D1. Canonical model identity is `provider/model[#variant]`

A model reference is the provider-owned identity that `logicalModel` already produces. `#variant` is a generic intensity or variant selector, and each runner maps it to its own form or rejects it:

| Runner | Providers it executes | Native model | `#variant` |
|---|---|---|---|
| `opencode` | any configured provider (gateways apply) | `provider/model#variant` unchanged | provider variant |
| `claude-code` | `anthropic` | `model` without the provider (`claude-opus-5-5`) | `--effort` level, else rejected |
| `codex` (`add-codex-runner`) | `openai` | `model` without the provider | reasoning effort |

Runner-local aliases are written in the same shape (`anthropic/opus`, `anthropic/sonnet`, `anthropic/haiku` on Claude). They are valid only on a runner that declares them. Any other runner rejects them with a message naming the runners that accept them. Built-in pipelines use these aliases, so they do not pin versions.

### D2. A route is `{ runner?, model? }`; a string is a route without a runner

```yaml
defaults:
  runner: codex                  # steps that name no runner
  model: openai/gpt-5.5
  advisor: { runner: claude-code, model: anthropic/opus }
  judge: anthropic/haiku         # inherits defaults.runner; must be executable there
  helpers:
    commitMessage: { runner: claude-code, model: anthropic/haiku }

pipelines:
  example:
    - agent: implementer
      runner: opencode
      model: openai/gpt-5.5      # same ID, different harness
    - agent: tests
      models:                    # fan-out entries are routes; runners may differ
        - openai/gpt-5.5
        - { runner: claude-code, model: anthropic/sonnet }
```

The same type, `ModelRoute`, is parsed and validated once and used by every model-bearing key. The resolved form is `{ runner: RunnerId, model: CanonicalModel }`. It is frozen in the plan and printed in review as `model · runner`.

### D3. Runner inheritance is explicit and fails loudly

A route's runner is the first one found in this order:

1. its own `runner`;
2. the enclosing context: a step's runner for its model and its advisor, or the step's runner for each `models:` entry;
3. `defaults.runner`;
4. `opencode`.

There is no inference from the provider. If the inherited runner cannot execute the model (D1), validation fails, names where the runner came from, and suggests setting `runner:` on the route. This keeps today's error for "inherited claude-code meets an OpenCode model" as a generic rule.

### D4. Runner descriptors are the only place a runner is described

```ts
type RunnerDescriptor = {
  id: RunnerId                          // validated string, not a closed union
  displayName: string
  sessionName: string
  declaration: CapabilityDeclaration    // existing D4 of unify-runner-system
  models: {
    accepts(model: CanonicalModel): { native: NativeModel } | { rejected: string }
    aliases?: readonly string[]
    defaultModel?: CanonicalModel       // used when a route names none
  }
  auth?: {
    modes: readonly AuthenticationMode[]
    parse(raw: unknown, v: Validator): RunnerAuthConfig
    verify(selection, env): Promise<EffectiveAuth>  // preflight and each attempt
  }
  probe(): Promise<{ installed: boolean; version?: string; remediation?: string }>
  inference?: HelperInference           // judge, branch name, commit text, advisor consult
  conversations?: ConversationSupport   // authoring sessions
  prompt?: { reportTool: string }       // how the agent names write_report
}
```

`StepRunnerId` stops being the closed union `"opencode" | "claude-code"`. It becomes a `RunnerId` checked against the registry at config load. `stepRunnerFor`, `isStepRunnerId` and `resolveStepRunnerCapabilities` read the registry. `compose.ts` registers each descriptor next to its execution adapter.

A conformance test fails when a runner ID literal (`"claude-code"`, `"opencode"`, `"codex"`) appears outside `src/runners/<id>/**`, the registry module and the built-in pipeline definitions. This extends `test/runner-adapter-direction.test.ts`.

### D5. Runner settings live under `runners.<id>`

```yaml
runners:
  claude-code:
    auth: { authMode: subscription, billingPolicy: account-policy }
  codex:
    auth: { authMode: api-key, credentialRef: CONVOY_OPENAI_KEY }
```

Each descriptor parses its own block, so the config validator stays generic. A route may carry `authMode` to override its runner's mode, which keeps the old `advisorRoute.authMode`. Its `credentialRef` comes from that runner's block. Plan dependencies, preflight and provenance record `{ runner, authMode, credentialRef }` the same way for every runner.

### D6. The CLI override is `--runner` plus `--model`

- `--runner <id> --model <m>` routes every agent step to that runner and model. Validation applies D1 to each step.
- `--model <m>` alone overrides the model on steps whose runner accepts it. Steps whose runner rejects it keep their model, and review lists them.
- `--runner <id>` alone moves steps to that runner with their own models and fails on any model the runner rejects.
- `--model claude-code/<m>` is read as legacy (D7).

### D7. Legacy spellings are read, warned and frozen canonically

| Legacy | Read as |
|---|---|
| `claude-code/<m>` in any model field or `--model` | `{ runner: claude-code, model: anthropic/<m> }` (`default` and an empty value become the runner's default model) |
| bare Claude alias or `claude-*` on a Claude step | `anthropic/<m>` |
| `defaults.claudeAuth` | `runners.claude-code.auth` |
| `defaults.advisorRoute`, `helperRoutes`, `autoAcceptJudgeModel`, `branchNameModel`, `commitMessageModel` | `defaults.advisor`, `defaults.helpers.*`, `defaults.judge` routes |
| frozen plan with `providerID: "claude-code"` advisor or judge | canonical route |

Each legacy key reports one deprecation line naming the replacement. Written files are never rewritten silently: the config screen already opens the file in the operator's editor. Removal is a later change.

### D8. Fan-out names stay unique across runners

`slugifyModel` names fan-out phases after the model. When two entries share a model on different runners, the slug gains the runner's `sessionName`. That avoids name collisions in the plan, the reports and the step commits.

## Risks / Trade-offs

- **Wide, mechanical diff.** It touches ~25 files. Land it as steps (registry and types, then routes, then config and legacy, then CLI and docs), each green on the existing suite. The suite is the regression gate, because configs that already work must resolve identically. A golden test compares resolved plans for every built-in pipeline and the repo fixtures before and after.
- **Aliases are a soft exception to "one spelling".** They are accepted because version pinning in built-ins costs more. The rule is still that a model never encodes its runner.
- **Advisor inheritance changes meaning slightly.** Today an un-prefixed advisor always consults through OpenCode, whatever the step's runner. Under D3 it inherits the step's runner. Legacy reading preserves today's routing for existing configs: an advisor string from a pre-change config with no runner resolves to `opencode`, flagged by the deprecation pass. Only the new spelling uses D3.

## Open Questions

- Should `modelRouting` (gateways) move under `runners.opencode`? It is OpenCode-only. This change leaves it at the top level and documents its scope.
