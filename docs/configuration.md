# Configuration

[Documentation](README.md) · [Convoy](../README.md)

Configure pipelines, agents, advisors, hooks, and project context.

- [Project configuration (`.convoy/config.yaml`)](#project-configuration-convoyconfigyaml)
- [Global configuration](#global-configuration)
- [Config files (`convoy config`)](#config-files-convoy-config)
- [Turning off worktrees or specs (`features`)](#turning-off-worktrees-or-specs-features)
- [Initializing config files (`convoy init`)](#initializing-config-files-convoy-init)
- [Overriding an agent prompt (`convoy agents eject`)](#overriding-an-agent-prompt-convoy-agents-eject)
- [Project Context And Custom Agents](#project-context-and-custom-agents)
- [Efficient Attachments](#efficient-attachments)

## Project configuration (`.convoy/config.yaml`)

A project can reshape convoy entirely from one file. Everything is optional — the file only declares what differs from the defaults. The same schema also lives globally at `~/.convoy/config.yaml` (see [Global configuration](#global-configuration)); the project file is merged on top of it.

```yaml
version: 1

defaults:
  model: openai/gpt-5.6-terra#xhigh     # provider/model[#variant], used by steps with no model of their own
  baseRef: main                    # optional; auto-detected when unset (origin default branch, else main/master/develop/trunk, else current branch)
  pipeline: quick                  # pipeline used when -p/--pipeline is not given
  autoAcceptJudgeModel: anthropic/claude-haiku-4-5   # model for smart auto-accept (--smart); defaults to the run's model
  branchNameModel: openrouter/deepseek/deepseek-v4.1-flash  # proposes worktree branch names (may look up referenced issues); you confirm the name
  commitMessageModel: openai/gpt-5.6-luna     # writes the conventional commit message for automatic run compaction and close's squash-merge commit
  worktree: true                   # force a new branch + worktree for every run; false always runs in the current tree. Unset decides per branch (isolate on a trunk, run in place on a branch)
  worktreeLocation: ~/dev/worktrees/{repo}/{branch}  # where isolated worktrees are created ({repo}/{branch} placeholders, ~ = home; the branch slug is appended when {branch} is missing). A marker line in the repo's AGENTS.md/README.md outranks this; default ~/.convoy/worktrees
  prdHistory: true                 # store each new run's git-ignored prompt under .convoy/prd-history; false disables writes and historical attachments
  advisor: anthropic/claude-opus-5   # optional; a stronger model consulted at every step's decision points
  advisorMaxCalls: 1000              # optional; consultations allowed per phase attempt (default 1000 — effectively unlimited; set it lower to cap advisor spend)
  advisorAuditPolicy: summary        # summary (hash-only default), redacted, or full transcript/advice content
  runner: opencode                   # optional; runner for steps that name none (opencode, claude-code, or codex)
  advisorRoute:                      # optional; the default advisor's runner/model/auth
    runner: claude-code
    model: anthropic/opus
  helperRoutes:                      # optional; branch namer and commit writer routes
    commitMessage: { runner: codex, model: openai/gpt-5.5#low }
  authoring:                         # optional; harness for Iterate, conversations, and Propose (opencode or claude-code)
    runner: claude-code

# Per-runner settings (see docs/runners.md). A CLI runner's auth: subscription
# (default) or api-key with credentialRef: <ENV_VAR>, plus the billing decision
# unattended launches need (included-only is refused). defaults.claudeAuth is
# the older spelling of runners.claude-code.auth and still reads.
runners:
  claude-code:
    auth:
      authMode: subscription
      billingPolicy: account-policy
  codex:
    auth:
      billingPolicy: account-policy

# Project agents: the prompt lives at .convoy/agents/<name>.md (required).
# Naming a built-in agent here overrides its model/temperature/readOnly instead.
agents:
  api-reviewer:
    description: Reviews public API consistency
    model: anthropic/claude-opus-5
    temperature: 0.1
    readOnly: true               # disables write/edit/bash tools for this agent
    advisor: anthropic/claude-opus-5   # optional; beats defaults.advisor for steps using this agent

pipelines:
  quick:
    description: Implementation, manual gate, tests
    defaultPrompt: Implement this change and leave it ready for review.   # optional; prefills the launcher and lets `convoy -p quick` run without a prompt
    suggestedPrompts:                                                     # optional; Tab-cycled through the launcher while the prompt is clean
      - Implement this change and leave it ready for review
      - Add tests for the new behavior
    steps:
      - implementer                # string = agent (or alias) with that step name
      - type: human                # named human gate, placeable anywhere, repeatable
        name: planning
        description: Plan implementation interactively
      - agent: tests
  api:
    steps:
      - implementer
      - agent: api-reviewer
        verify: true               # optional; read-only step gets bash back so it can run tests/checks
        prdHistory: true           # optional; attach the original PRD recorded for this branch
      - type: human
        name: api-review
      - agent: security
        reports: all               # attach every previous step report (default: the nearest one)
      - agent: adversarial
        name: final-check          # step name (report file, commit prefix, --only/--skip)
        reports: [implementer, security]
  audit:
    steps:
      - implementer
      - parallel:                  # runs its steps concurrently; every one is forced read-only
          - patterns
          - security
          - agent: clean-code
            models:                # fans this one step out across models, one read-only run per model
              - anthropic/claude-opus-5
              - openai/gpt-5.6-terra#xhigh
      - agent: adversarial
        name: triage
        reports: all               # every parallel/fan-out report from above, in one attachment set

hooks:                              # optional shell hooks; top-level = every pipeline
  pre:
    - pnpm lint
  post:
    - command: ./scripts/notify.sh
      when: always                  # success | failure | always; post default is success
      continueOnError: true         # don't fail the run if this hook fails
  pipelines:                        # appended only for the named pipeline
    quick:
      post:
        - name: open-pr
          command: gh pr create --fill
          cwd: target               # target (default) | run
          timeoutSeconds: 120

permissions:                       # additive only; a config allow can never undo a deny
  allow:
    - "supabase gen types*"
  deny:
    - "stripe *"

loopGuard:                         # optional; circuit breaker for a phase that is going nowhere
  enabled: true                    # false turns the whole guard off
  identicalCalls: 4                # same tool + same args in a row
  sameToolFailures: 6              # same tool failing in a row (args may drift)
  maxSteps: 200                    # hard budget gate; a best-effort model-only nudge is queued at half this value
  maxPhaseCost: 20                 # USD per phase attempt; false disables just the cost fuse

attachments:                       # attached to every step, like repeatable --file flags
  - docs/architecture.md
```

The rules:

- **Precedence**: CLI flag > project config > global config > built-in default. Within a config, for OpenCode models specifically: step `model` > agent `model` > `defaults.model` > the agent's built-in preference (for example, Opus via OpenRouter for adversarial review and Grok for scoring; explicit pipeline models take precedence) > `openai/gpt-5.6-terra#xhigh`. `--model` overrides OpenCode steps only; scope it to a CLI runner as `--model codex/<model>` or `--model claude-code/<model>`, and Convoy names the steps an override did not reach at launch. A model is spelled the same on every runner (`openai/gpt-5.5`); the step's `runner` decides who executes it — see [Runners](runners.md#models-one-spelling-any-runner) for routes (`{ runner, model }`) and fan-outs that mix runners.
- **Conventions over wiring**: every agent step gets the PRD, the cumulative diff against the base branch (except the first step; opt out with `diff: false`), and the previous step's report (`reports: previous|all|none|[names]`). Its report lands at `reports/<step>.md`; writable steps commit repository changes as `convoy(<step>): …`, while read-only steps verify that the repository stayed unchanged.
- **Aliases**: the built-in agents answer to their short names in steps — `patterns`, `security`, `design`, `tests`, `adversarial`, `run-report` — as well as their full names.
- **Read-only agents**: set `agents.<name>.readOnly: true` to enforce audit-only behavior. Convoy disables the agent's write/edit/bash tools, denies edit/bash/task permissions, saves the phase report from the assistant response if the agent cannot write it directly, and checks the clean Git baseline before finalizing. If Git-visible files, HEAD, or the active branch change during the step, Convoy fails without committing or deleting anything; the changes stay intact for the user to inspect and resolve.
- **Verifying steps**: add `verify: true` on a **step** (not on the agent) to hand a read-only step bash back under the same policy writable agents get. Allowlisted project test/typecheck/lint scripts run silently; the hard denylist (`git push`, `sudo`, installs, …) stays deny — OpenCode rejects those before the gate, and `--yolo` cannot approve them. It exists because a validator that cannot run anything can only restate what earlier phases claimed. Built-in pipelines set it on the steps that need it: `scope` in `review` / `ship`, `score-report` in `review` and the embedded goal measures of `full-cycle` / `ship`, and `validation` in `fixer`. Project pipelines that use `review-validator` or `implementation-validator` must set `verify: true` on those steps themselves. Write and edit tools stay disabled and the clean-baseline check above still runs, so a verifying step that changes the repository fails like any other read-only one. Two caveats worth knowing: bash can write through shell redirection, so "doesn't write" is enforced by the Git baseline rather than by the tool list, and anything Git ignores (build caches, coverage output) is invisible to that check. `verify` is ignored unless the agent is `readOnly`, and it is dropped for steps forced read-only by `parallel:` or `models:`, where concurrent agents would fight over one working tree. On `runner: claude-code` steps it adds Claude's Bash tool under the same command policy, enforced by Convoy's PreToolUse hook.
- **Human steps**: use `type: human` with optional `name` and `description` to insert an interactive gate. The old `human-review` string still works as a legacy shorthand, but named `type: human` steps are preferred for planning, QA, approval, or any other human checkpoint.
- **Advisor steps**: set `advisor: <provider/model[#variant]>` on a step to give its executor a stronger reviewing model, consulted at decision points without ever running tools or producing the deliverable. The point is that the cheap model keeps the loop and the whole transcript — the advisor reads that transcript verbatim, so nothing is re-serialized across a handoff and no intent is lost, which is the failure mode of plan-then-execute pipelines. It is consulted at three moments: **before the phase's first write** (Convoy holds that edit, consults, and hands back the advice mid-turn), **before the phase is accepted as done** (the advisor reviews the finished work and can send the phase one more turn in the same session), and **on demand** through an `advisor` tool the executor calls when it is stuck or about to commit to an approach. Precedence mirrors models: step `advisor` > agent `advisor` > `defaults.advisor`, with `advisor: false` opting one step out of a broader default and no built-in fallback, so a config that doesn't ask for an advisor costs exactly what it costs today. `--advisor <model>` and `--no-advisor` force either end for a whole run, which is how you compare executor-only, executor+advisor, and advisor-only over one unmodified pipeline. Advisor output is capped (a synthetic `convoy-advisor-*` model alias overrides only `limit.output`, inheriting real credentials and pricing from the model it names) and its spend is reported separately in `SUMMARY.md` as an executor/advisor token split — if the advisor's share of output is not small, the pattern is wired backwards. Every request, completion/failure, delivery, exhausted budget, and `advisor_feedback` adoption decision is appended to the private `events/advisor.jsonl` journal and shown in the phase's **advisor** dashboard tab. `defaults.advisorAuditPolicy` controls content retention: `summary` stores hashes and lengths, `redacted` stores lengths only, and `full` is explicit opt-in to store content. Every advisor failure degrades rather than failing the phase. Every runner's steps take an advisor, and any runner can advise any executor: a route such as `advisor: { runner: claude-code, model: anthropic/opus }` (or the shorthand `claude-code/opus`, `codex/gpt-5.5`) consults that CLI runner, a plain model consults through OpenCode (see [Runners](runners.md#reports-and-advisors)); `defaults.advisorRoute` sets the default advisor's runner, model, and auth.
- **Claude Code steps**: set `runner: claude-code` on a step (or `defaults.runner: claude-code` for every step that names none) to execute it with the locally installed [`claude` CLI](https://code.claude.com) instead of an OpenCode session. Claude steps implement, audit, verify, score, fan out across `models:`, take advisors, and run in `parallel:` groups like OpenCode steps. The optional `model` accepts `opus`, `sonnet`, `haiku`, a `claude-*` ID, or the equivalent `anthropic/claude-*` form; omit it to use the CLI default. Authentication is `runners.claude-code.auth` (subscription by default, or an explicit API key by variable name; `defaults.claudeAuth` is the older spelling) with a separate `billingPolicy`; preflight verifies the effective auth before any work. Convoy loads its PreToolUse hook and MCP host per invocation — never `--bare` or blanket `--safe-mode` — so the project's guidance (`CLAUDE.md`) loads while Convoy's policy decides every tool call; reports go through the same `write_report` contract as OpenCode. Steps stream into the dashboard through the coordinator's journal, their raw event stream is written to `logs/<step>.<attempt>.claude.jsonl`, and once a step finishes `[o]` reopens its exact session read-only with `claude --resume` for inspection. Claude Code is an **optional dependency**: only a plan that uses it (a step, an advisor, the judge, or a helper) requires the CLI, checked at preflight; a plan that uses only Claude never needs OpenCode. See [Runners](runners.md).
- **Codex steps**: set `runner: codex` on a step (or `defaults.runner: codex`) to execute it on the locally installed [`codex` CLI](https://developers.openai.com/codex), through an `app-server` child Convoy owns. Codex steps implement, audit, verify, score, fan out across `models:`, take advisors, and run in `parallel:` groups like the other runners. The optional `model` accepts `openai/<id>` or a bare Codex model ID, with an optional reasoning effort (`openai/gpt-5.5#high`); omit it to use Codex's default. Every command, file change, and MCP call Codex attempts is approved one at a time by Convoy's policy and the run's operator gate; Codex reads through shell inspection (`cat`, `rg`, `git diff`…), which Convoy judges as reads, so read-only steps can read. The operator's Codex hooks, apps, and MCP servers are kept out of runs. Authentication is `runners.codex.auth` (the ChatGPT login by default, or an explicit API key by variable name, logged in to a private per-use Codex home); preflight verifies the account and that it offers every Codex model and effort the plan names. Raw protocol events go to `logs/<step>.<attempt>.codex.jsonl`, and `[o]` reopens a finished step with `codex resume`. Codex is an optional dependency checked at preflight; authoring conversations stay on OpenCode or Claude. See [Runners](runners.md#how-convoy-integrates-with-codex).
- **Loop guard**: OpenCode's own `doom_loop` detector only sees repeated tool calls inside a *single* assistant message, so a Kimi/GLM session that calls the same tool once per turn can keep going (and billing) indefinitely. Convoy's `loopGuard` is a circuit breaker on the live event stream. It trips on the same tool called with the same arguments `identicalCalls` times in a row, the same tool failing `sameToolFailures` times in a row (even when the arguments drift), `maxSteps` model round-trips, or `maxPhaseCost` USD spent by the executor — each measured consecutively, so a success or a changed argument resets the streak. At half `maxSteps`, Convoy best-effort queues a model-only reminder to review its progress; it does not interrupt the session or show a dashboard warning, and it is not guaranteed to appear in the model's next turn. At `maxSteps` (200 by default), Convoy aborts the session and opens a **budget gate**: choose **Reset and continue** to reset only the step counter to zero and re-prompt the phase, or **Abort** to stop the run. Without an interactive terminal or dashboard, the hard gate fails the phase instead of continuing silently. The guard is per phase attempt (shared with the advisor's follow-up turn); a budget reset preserves the attempt's accumulated cost and other fuse state. `enabled: false` turns it off; `maxPhaseCost: false` disables just the dollar fuse. OpenCode's `doom_loop` permission is `ask` (its schema does not accept a per-tool map; an object there is `ConfigInvalidError`). Convoy's permission gate then allows it for `read`/`grep`/`glob`/`list` (sectional file reads look like a loop) and rejects it for write/bash — that reject cannot be overridden by `--yolo`. Convoy deliberately does not set OpenCode's `agent.steps`, whose hardcoded maximum-steps prompt can stop tool use and let a partial report advance the pipeline. Work already written to the repo is kept. Unset keys use the defaults shown above; tune `maxPhaseCost` down (8–10) if Kimi/GLM burn still stings, or up if a long Opus/GPT implementer phase trips it on legitimate work.
- **Parallel steps and model fan-out**: wrap steps in `parallel: [...]` to run them concurrently, and/or give one step a `models: [...]` list (instead of `model:`) to run it once per model. Both are always forced read-only, regardless of the underlying agent's own `readOnly` setting. Convoy restricts built-in write tools and verifies the Git baseline before finalizing, so any Git-visible mutation fails the step and remains untouched for manual resolution — there's no per-step way to opt out. A `models:` step's variants get disambiguated names (`<step>__<model-slug>`) and reports; `reports: previous` after a parallel block attaches every member's report, and `reports: [<step-name>]` on a fanned-out step's un-suffixed name attaches every one of its model variants. `parallel:` can't nest and can't contain human steps.
- **Project pipelines shadow built-ins**: defining `pipelines.implement` replaces the built-in `implement`; defining `pipelines.full-cycle` replaces the default pipeline.
- **Default and suggested prompts**: a pipeline can define `defaultPrompt` — text prefilled in the launcher's prompt field and used by `convoy -p <pipeline>` when no prompt is given — plus `suggestedPrompts`, a list the launcher Tab-cycles through while the field is still clean (empty or holding a default). Editing the field makes it yours: it survives pipeline switches and stops Tab from overwriting it. Built-ins that exist to run one concrete action (`review`, `hunter`, `ship`) ship with a `defaultPrompt`; pipelines where the prompt IS the description (`implement`, `fixer`, ...) leave the prompt mandatory.
- **`--no-human-step` / `--no-human-review`** (and non-TTY runs) drop every human gate from the pipeline.
- **Resume is frozen**: the resolved pipeline is persisted in the run's `metadata.json`; `--resume` replays it even if the config changed since.
- **Dirty-tree recovery**: a writable phase interrupted before its commit (Ctrl+C, a failed commit step, a killed process) leaves uncommitted work in the tree, which normally blocks `--resume`. In an interactive terminal, resume offers to commit that work as the interrupted phase (`convoy(<phase>): …` with the resumed run's `Convoy-Run` trailer), mark it done, and continue with the following phases. If the interrupted phase had already accepted a structured commit description through `write_report`, recovery reuses it; otherwise the message describes the staged paths or says plainly what happened. Read-only phases are never recoverable as agent output: preserved changes must be resolved manually, and resume also verifies their recorded HEAD/branch baseline. Decline (or a non-TTY resume) keeps the old "commit/stash first" behavior.
- **Permissions are additive**: `permissions.deny` extends the hard denylist, `permissions.allow` extends the allowlist, deny always wins, and there is deliberately no way for a repo to grant itself `--yolo`.
- **Hooks are trusted local shell commands**: `hooks.pre` runs after the run workspace/dashboard is initialized and before the pipeline starts (pre-hooks are skipped on `--resume`); `hooks.post` runs at the end according to `when`. Top-level hooks apply to every pipeline, and `hooks.pipelines.<name>` entries are appended for that pipeline. Hooks run via `$SHELL -lc` from the target repo by default, receive `CONVOY_RUN_ID`, `CONVOY_RUN_DIR`, `CONVOY_TARGET_DIR`, `CONVOY_PIPELINE`, `CONVOY_PROMPT_FILE`, and post-hooks also receive `CONVOY_RUN_STATUS`, plus `CONVOY_RUN_SCORE` on a scored pipeline and `CONVOY_GOAL_REACHED`/`CONVOY_GOAL_SCORE`/`CONVOY_GOAL_TARGET` when a [goal loop](quality-and-goals.md#goal-mode) ran (in which case post-hooks run once, after the loop, not once per iteration). Success post-hooks run **after** automatic compaction and receive its outcome as `CONVOY_FINALIZATION_STATE` (plus `CONVOY_FINALIZATION_SHA`, `CONVOY_FINALIZATION_SUBJECT`, and `CONVOY_FINALIZATION_REASON` when set), so a publish hook can gate on a completed compaction. A failing hook fails the run unless `continueOnError: true` is set. Each hook is also a row in the dashboard pipeline — pre-hooks ahead of the steps and post-hooks after the `Compact run` row — with live running/✓/✗/skipped status, and the tail of its output lands in that row's `logs` tab; the rows and their captured output are recorded in the run metadata, so re-opened runs show them too.

## Global configuration

`~/.convoy/config.yaml` uses the exact same schema as the project file and sets your personal defaults across every repo — most usefully `defaults.model`, but also custom agents and pipelines. Global custom agents bring their prompt at `~/.convoy/agents/<name>.md` (the same convention a project uses, relative to your home).

Both files are merged before a run, with the project winning: `defaults`, `agents`, and `pipelines` merge by key/name (a project entry overrides the global one of the same name), while `permissions`, `hooks`, and `attachments` concatenate (global first; `deny` still wins). The home directory convoy reads can be relocated with `CONVOY_HOME` (it points at the directory that holds `.convoy`, and also moves `~/.convoy/runs`).

## Config files (`convoy config`)

`convoy config` (or **Config** in the TUI) shows the [feature switches](#turning-off-worktrees-or-specs-features) as toggles, then lists the files that shape the current project and opens them in your own editor. Apart from the switches, Convoy doesn't edit YAML through forms; your editor is better at it.

The **Features** rows show each switch's value and where it comes from (default, the global config, or this project). `space` flips one and saves it in the project's `.convoy/config.yaml`, which wins over the global config. Only that line changes, so the file keeps its comments; a missing project config is created from the `convoy init` template first, and one that doesn't load is left alone until you fix it.

- **Global:** `~/.convoy/config.yaml` and any agent prompt overrides in `~/.convoy/agents/`.
- **Project:** `.convoy/config.yaml` (or `config.yml`) and any agent prompt overrides in `.convoy/agents/`.

Each row says whether the file loads, and a file that doesn't load shows the parser's error. `enter` opens the selected file in `$VISUAL`, then `$EDITOR` (arguments allowed, such as `code -w`), then the first of `nano`, `vim`, or `vi` found on `PATH`. A config file that doesn't exist yet is created from the same commented template `convoy init` writes, then opened. When the editor closes, the screen loads the file again and tells you if it stopped loading. `r` refreshes, `q` goes back. Needs an interactive terminal.

## Turning off worktrees or specs (`features`)

Both areas are on by default. Turn off the ones you don't use from the Features toggles in `convoy config`, or in YAML, globally or per project (the project wins, per switch):

```yaml
features:
  worktrees: false   # open the TUI on Pipelines, and don't isolate runs automatically
  specs: false       # no OpenSpec in the TUI or in run plans
```

- **`worktrees: false`** drops the worktree board. The TUI opens on the run launcher, which becomes the first screen: `r` opens Runs, `c` Config, `o` Specs (when specs are on), and `q` quits. Runs no longer get their own worktree by default. An explicit `--worktree` or `defaults.worktree: true` still isolates, and `convoy worktrees` still works when you call it.
- **`specs: false`** removes the Specs destination, the OpenSpec actions and linked specs from a worktree's detail, and the launcher's change picker. Run plans attach no OpenSpec bundle and don't ask for `--change` or `--manual`, even in a repo with an `openspec/` folder. `--change`, `convoy specs`, and `convoy spin` refuse with a message that names the switch. The close action stays, as the squash merge it still is.

## Initializing config files (`convoy init`)

`convoy init` writes a commented starter config without opening anything; `convoy config` creates the same file when you open a missing one.

```bash
convoy init                # .convoy/config.yaml in the current repo
convoy init --dir ../app   # same, in another repo
convoy init --global       # ~/.convoy/config.yaml
convoy init --force        # overwrite an existing config
```

`init` deliberately writes **no** agent prompts. A file at `agents/<name>.md` overrides its built-in permanently, so seeding all of them would freeze every prompt at the version you installed and silently discard the improved prompts that later `convoy update` runs ship.

## Overriding an agent prompt (`convoy agents eject`)

To customize a built-in agent's system prompt, copy that one prompt out and edit it:

```bash
convoy agents                             # list the ejectable agents
convoy agents eject implementer           # .convoy/agents/implementer.md in the current repo
convoy agents eject design-polisher --global   # ~/.convoy/agents/design-polisher.md
convoy agents eject implementer --force   # overwrite a prompt you already ejected
```

The ejected file wins over the built-in from then on, **including across upgrades** — `convoy update` ships new built-in prompts that an ejected file will shadow. Eject only what you mean to own, and delete the file to go back to the built-in. The runtime-safety and advisor-timing prompts are not ejectable: they are always read from the built-ins, so a copy would be inert.

The generated config documents every key (commented out) and inlines the built-in `implement` pipeline as an example so it's immediately editable. Prompts under `agents/` are picked up by name — eject one to override a built-in agent's prompt, or declare a new agent in the config and add its prompt file by hand. Existing files are never overwritten unless `--force` is given, and `--force` never reclaims an ejected prompt. `make install` runs `convoy init --global` automatically, so a fresh install ships with a ready-to-edit global config.

## Project Context And Custom Agents

Convoy automatically attaches these target-repo files to every phase when they exist:

```text
.convoy/rules.md
AGENTS.md
CLAUDE.md
```

Use `.convoy/rules.md` for project-specific Convoy instructions. It is intentionally the only Convoy rules filename to avoid ambiguous precedence. `AGENTS.md` and `CLAUDE.md` are treated as additional repo context.

Built-in agent prompts live as Markdown files under `prompts/` and are compiled into the binary. A project can fully replace one with `convoy agents eject <agent>`, which produces:

```text
.convoy/
├── config.yaml          # defaults, agents, pipelines, hooks, permissions, attachments
└── agents/
    ├── implementer.md   # overrides the built-in implementer prompt
    ├── pattern-auditor.md
    └── api-reviewer.md  # prompt for a project agent declared in config.yaml
```

When a project override exists, it replaces that agent's built-in prompt completely. Project agents declared in `config.yaml` must bring their prompt at `.convoy/agents/<name>.md` (validated at startup). The same convention applies globally: `~/.convoy/agents/<name>.md` overrides a built-in for every repo. Prompt precedence is `.convoy/agents/<name>.md` (project) > `~/.convoy/agents/<name>.md` (global) > the built-in prompt. In all cases Convoy still appends its non-replaceable runtime safety guard rails from `prompts/runtime-safety.md`.

## Efficient Attachments

`--file` is repeatable and accepts files or directories. Relative paths are resolved against the target repo.

Convoy doesn't paste those contents into the prompt. It sends them to the SDK as `FilePartInput` with `file://` URL, just like OpenCode's `--file`. It does the same internally with `prd.md`, the original branch PRD for opted-in review scope steps, previous reports, and phase diffs.

---

[Back to documentation](README.md)
