# Pipeline files

A pipeline file is one YAML mapping: the same shape as a `pipelines.<name>` entry in `.convoy/config.yaml`, plus an optional `name`. Run it with `convoy --pipeline-file <path>`; nothing in the user's config changes. Validate it first:

```bash
convoy pipelines show --pipeline-file <path>          # schema errors, or the resolved steps
convoy --pipeline-file <path> --prompt-file <task> --manual --yolo --plan < /dev/null    # the full plan, models routed (--smart if it writes code)
```

## Top-level keys

| Key | Required | Meaning |
|---|---|---|
| `name` | no | Pipeline name: letters, digits, `-`, `_`. Defaults to the file name without `.yaml`. Names hooks (`hooks.pipelines.<name>`) and appears in run history. |
| `description` | no | One line shown in the plan and in `convoy runs`. |
| `steps` | yes | The ordered steps (below). |
| `defaultPrompt` | no | Prompt used when the launch gives none. |
| `maxConcurrentAgents` | no | Cap on agents running at once inside a `parallel:` block or `models:` fan-out. |

## Steps

Every step names an **agent**: a built-in one, or a project agent the user configured. `convoy pipelines` lists them with their descriptions; read-only agents never change the repository. Short aliases: `patterns`, `security`, `design`, `tests`, `adversarial`, `run-report`.

**A string** is an agent step with default settings: `- implementer`.

**An agent step:**

```yaml
- agent: bug-auditor          # required
  name: bugs                  # step name: report file (reports/bugs.md), --only/--skip, reports: [bugs]. Default: the agent name
  runner: codex               # who executes it: opencode (default), claude-code, or codex
  model: openai/gpt-5.5#high  # provider/model[#variant], executed by the step's runner (see "Runners and models")
  models: [model-a, model-b]  # instead of model: run the step once per model (forced read-only), reports bugs__<model-slug>.md
  advisor: openai/gpt-6-astra#xhigh   # a stronger model consulted at decision points; false opts out of a default
  reports: previous           # which earlier reports to attach: previous (default) | all | none | [step, ...]
  diff: true                  # attach the cumulative diff against the base (default: every step but the first)
  verify: true                # read-only step may still run tests/lint/typecheck through bash
  prdHistory: true            # attach the original PRD recorded for this branch
  deliverable: quality-score  # this step emits the machine-readable score a goal's measure ends in
```

Model precedence: step `model` > the agent's configured model > `defaults.model` > the agent's built-in preference. Omit `model` to accept that chain; `convoy pipelines show` shows what each step resolves to.

## Runners and models

A model is always spelled `provider/model[#variant]`; the step's `runner` decides who executes it, and a step without one runs on `defaults.runner`, else OpenCode.

| Runner | Executes | `#variant` | Needs |
|---|---|---|---|
| `opencode` | any provider OpenCode has credentials for (`openrouter/…`, `openai/…`, …) | the provider's variant | OpenCode V2 |
| `claude-code` | `anthropic/*`: `anthropic/opus`, `anthropic/sonnet`, `anthropic/haiku`, or a `claude-*` id (bare `opus` works too) | none | the `claude` CLI, logged in |
| `codex` (experimental) | `openai/*` (a bare Codex model id works too) | effort: `minimal`, `low`, `medium`, `high`, `xhigh` | the `codex` CLI 0.160+, logged in |

A runner never translates a model it can't execute: an `anthropic/*` model on a Codex step fails validation. Anywhere a model goes (`model`, each `models:` entry, `advisor`) you can write a route instead, `{ runner: claude-code, model: anthropic/sonnet }`, so one fan-out can mix runners. A plain-model `advisor` consults through OpenCode; give it a route (or the shorthand `claude-code/opus`, `codex/gpt-5.5`) to consult a CLI runner. A pipeline that never uses OpenCode doesn't need it installed.

**A parallel block** runs its steps concurrently; every member is forced read-only, so use it for audits and scoring, never for writing:

```yaml
- parallel:
    - agent: security-reviewer
      name: security
    - agent: bug-auditor
      name: bugs
      models: [openrouter/deepseek/deepseek-v4.1-flash-1017#high, openai/gpt-6.1-sol#high]
```

`reports: previous` on the step after a parallel block attaches every member's report. Parallel blocks can't nest.

**A human gate** (`type: human`, optional `name`, `description`) pauses for the operator. Detached and headless runs drop human gates unless launched with `--human-step`; avoid them in pipelines an agent launches.

**A goal step** (only as the last step) scores the branch and fixes gaps until it reaches `target`:

```yaml
- goal:
    target: 85              # 1-100
    maxIterations: 3        # improvement rounds after the first measurement (default 3)
    plateau: 3              # stop when a round adds fewer points (default 3)
    improve:
      briefStep: fix        # the one improve step that receives the score's gap list
      steps:
        - agent: goal-fixer
          name: fix
          reports: none
          diff: true
    measure:                # read-only, ending in exactly one quality-score deliverable
      steps:
        - parallel:
            - agent: quality-scorer
              name: score
              models: [openai/gpt-6.1-sol#xhigh, openrouter/z-ai/glm-5.3#high]
              reports: none
              diff: true
        - agent: quality-score-report
          name: score-report
          reports: [score]
          verify: true
          diff: true
```

Rules the validator enforces: the goal step comes last and appears once; `improve` steps can edit the repository; `measure` steps are read-only and end in one quality-score deliverable (`quality-score-report`, or any step with `deliverable: quality-score`); scorers never see the previous score.

## What every step gets

The prompt, the cumulative diff against the base branch (except the first step, or with `diff: false`), and the reports selected by `reports`. Each step writes `reports/<step>.md` in the run directory. A writable step's changes are committed as `convoy(<step>): …`; a read-only step that changes the repository fails. When the run succeeds, its commits are compacted into one.

## Choosing models

Use models and runners the user already runs: the ones in `convoy pipelines show <built-in>` are configured and authenticated, and a user on a Claude or ChatGPT subscription may prefer `claude-code` or `codex` steps. Spread audits across model families (they catch different things), keep the writer on one strong model, and add an advisor to a writer rather than a second writer. Unattended launches with `claude-code` or `codex` steps need the user's `runners.<id>.auth.billingPolicy: account-policy` (see SKILL.md, troubleshooting).

## Examples

### A focused, multi-model audit (read-only)

```yaml
name: payments-audit
description: Security and correctness audit of the payments module across two model families
steps:
  - agent: review-scope
    name: scope
    reports: none
    diff: true
    verify: true
  - parallel:
      - agent: security-reviewer
        name: security
        models: [openrouter/deepseek/deepseek-v4.1-flash-1017#high, openai/gpt-6.1-sol#high]
        reports: [scope]
      - agent: hunter-reliability
        name: reliability
        models: [openrouter/deepseek/deepseek-v4.1-flash-1017#high, openai/gpt-6.1-sol#high]
        reports: [scope]
  - agent: review-report
    name: report
    reports: all
```

Prompt: what to audit ("`src/payments/` and its callers: refunds, webhooks, idempotency"), and what to prioritize.

### Implement, test, and score to 85 (writes code)

```yaml
name: feature-85
steps:
  - agent: implementer
    reports: none
  - agent: tests
    reports: none
  - goal:
      target: 85
      maxIterations: 3
      improve:
        briefStep: fix
        steps:
          - agent: goal-fixer
            name: fix
            reports: none
            diff: true
      measure:
        steps:
          - agent: quality-scorer
            name: score
            models: [openai/gpt-6.1-sol#xhigh, openrouter/z-ai/glm-5.3#high]
            reports: none
            diff: true
          - agent: quality-score-report
            name: score-report
            reports: [score]
            verify: true
            diff: true
```

### Claude Code only (no OpenCode needed)

```yaml
name: claude-audit
steps:
  - agent: review-scope
    name: scope
    runner: claude-code
    model: anthropic/sonnet
    reports: none
    diff: true
    verify: true
  - agent: bug-auditor
    name: bugs
    runner: claude-code
    models: [anthropic/opus, anthropic/sonnet]
    reports: [scope]
  - agent: review-report
    name: report
    runner: claude-code
    model: anthropic/opus
    reports: all
```

### One audit across three harnesses

```yaml
name: cross-harness-bugs
steps:
  - agent: bug-auditor
    name: bugs
    runner: codex
    models:
      - openai/gpt-5.5#high                                # the step's runner: Codex
      - { runner: claude-code, model: anthropic/sonnet }
      - { runner: opencode, model: openrouter/z-ai/glm-5.3#high }
  - agent: review-report
    name: report
    runner: claude-code
    model: anthropic/opus
    reports: all
```

## Custom agents

A pipeline file composes registered agents; it can't define new prompts. When no agent fits, steer an existing one through the prompt, or ask the user whether to add a project agent (`agents.<name>` in `.convoy/config.yaml` with its prompt at `.convoy/agents/<name>.md`), which is their config to change.
