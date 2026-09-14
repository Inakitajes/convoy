# Configuration

[Documentation](README.md) · [Convoy](../README.md)

Configure pipelines, agents, advisors, hooks, and project context.

- [Project configuration (`.convoy/config.yaml`)](#project-configuration-convoyconfigyaml)
- [Global configuration](#global-configuration)
- [Editing config interactively (`convoy config`)](#editing-config-interactively-convoy-config)
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
  branchNameModel: openrouter/deepseek/deepseek-v4-flash-0731  # proposes worktree branch names (may look up referenced issues); you confirm the name
  commitMessageModel: openai/gpt-5.6-luna     # writes the conventional commit message for automatic run compaction and close's squash-merge commit
  worktree: true                   # force a new branch + worktree for every run; false always runs in the current tree. Unset decides per branch (isolate on a trunk, run in place on a branch)
  worktreeLocation: ~/dev/worktrees/{repo}/{branch}  # where isolated worktrees are created ({repo}/{branch} placeholders, ~ = home; the branch slug is appended when {branch} is missing). A marker line in the repo's AGENTS.md/README.md outranks this; default ~/.convoy/worktrees
  prdHistory: true                 # store each new run's git-ignored prompt under .convoy/prd-history; false disables writes and historical attachments
  advisor: anthropic/claude-opus-5   # optional; a stronger model consulted at every step's decision points
  advisorMaxCalls: 1000              # optional; consultations allowed per phase attempt (default 1000 — effectively unlimited; set it lower to cap advisor spend)
  advisorAuditPolicy: summary        # summary (hash-only default), redacted, or full transcript/advice content

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

- **Precedence**: CLI flag > project config > global config > built-in default. Within a config, for OpenCode models specifically: step `model` > agent `model` > `defaults.model` > the agent's built-in preference (for example, Opus via OpenRouter for adversarial review and Grok for scoring; explicit pipeline models take precedence) > `openai/gpt-5.6-terra#xhigh`. `--model` overrides OpenCode steps only; Claude Code steps keep their own CLI model and Convoy names those unaffected steps at launch.
- **Conventions over wiring**: every agent step gets the PRD, the cumulative diff against the base branch (except the first step; opt out with `diff: false`), and the previous step's report (`reports: previous|all|none|[names]`). Its report lands at `reports/<step>.md`; writable steps commit repository changes as `convoy(<step>): …`, while read-only steps verify that the repository stayed unchanged.
- **Aliases**: the built-in agents answer to their short names in steps — `patterns`, `security`, `design`, `tests`, `adversarial`, `run-report` — as well as their full names.
- **Read-only agents**: set `agents.<name>.readOnly: true` to enforce audit-only behavior. Convoy disables the agent's write/edit/bash tools, denies edit/bash/task permissions, saves the phase report from the assistant response if the agent cannot write it directly, and checks the clean Git baseline before finalizing. If Git-visible files, HEAD, or the active branch change during the step, Convoy fails without committing or deleting anything; the changes stay intact for the user to inspect and resolve.
- **Verifying steps**: add `verify: true` on a **step** (not on the agent) to hand a read-only step bash back under the same policy writable agents get. Allowlisted project test/typecheck/lint scripts run silently; the hard denylist (`git push`, `sudo`, installs, …) stays deny — OpenCode rejects those before the gate, and `--yolo` cannot approve them. It exists because a validator that cannot run anything can only restate what earlier phases claimed. Built-in pipelines set it on the steps that need it: `scope` in `review` / `ship`, `score-report` in `review` and the embedded goal measures of `full-cycle` / `ship`, and `validation` in `fixer`. Project pipelines that use `review-validator` or `implementation-validator` must set `verify: true` on those steps themselves. Write and edit tools stay disabled and the clean-baseline check above still runs, so a verifying step that changes the repository fails like any other read-only one. Two caveats worth knowing: bash can write through shell redirection, so "doesn't write" is enforced by the Git baseline rather than by the tool list, and anything Git ignores (build caches, coverage output) is invisible to that check. `verify` is ignored unless the agent is `readOnly`, and it is dropped for steps forced read-only by `parallel:` or `models:`, where concurrent agents would fight over one working tree. Not available on `runner: claude-code` steps, whose tool envelope excludes Bash.
- **Human steps**: use `type: human` with optional `name` and `description` to insert an interactive gate. The old `human-review` string still works as a legacy shorthand, but named `type: human` steps are preferred for planning, QA, approval, or any other human checkpoint.
- **Advisor steps**: set `advisor: <provider/model[#variant]>` on a step to give its executor a stronger reviewing model, consulted at decision points without ever running tools or producing the deliverable. The point is that the cheap model keeps the loop and the whole transcript — the advisor reads that transcript verbatim, so nothing is re-serialized across a handoff and no intent is lost, which is the failure mode of plan-then-execute pipelines. It is consulted at three moments: **before the phase's first write** (Convoy holds that edit, consults, and hands back the advice mid-turn), **before the phase is accepted as done** (the advisor reviews the finished work and can send the phase one more turn in the same session), and **on demand** through an `advisor` tool the executor calls when it is stuck or about to commit to an approach. Precedence mirrors models: step `advisor` > agent `advisor` > `defaults.advisor`, with `advisor: false` opting one step out of a broader default and no built-in fallback, so a config that doesn't ask for an advisor costs exactly what it costs today. `--advisor <model>` and `--no-advisor` force either end for a whole run, which is how you compare executor-only, executor+advisor, and advisor-only over one unmodified pipeline. Advisor output is capped (a synthetic `convoy-advisor-*` model alias overrides only `limit.output`, inheriting real credentials and pricing from the model it names) and its spend is reported separately in `SUMMARY.md` as an executor/advisor token split — if the advisor's share of output is not small, the pattern is wired backwards. Every request, completion/failure, delivery, exhausted budget, and `advisor_feedback` adoption decision is appended to the private `events/advisor.jsonl` journal and shown in the phase's **advisor** dashboard tab. `defaults.advisorAuditPolicy` controls content retention: `summary` stores hashes and lengths, `redacted` stores lengths only, and `full` is explicit opt-in to store content. Every advisor failure degrades rather than failing the phase. Not available on `runner: claude-code` steps, which own their own loop.
- **Claude Code steps**: set `runner: claude-code` on an audit step to execute it with the locally installed [`claude` CLI](https://code.claude.com) instead of an OpenCode session, authenticated by whatever that install already uses — a Claude subscription login or an API key. This is how subscription users get genuine cross-vendor diversity in review pipelines without paying per token. The optional `model` accepts `opus`, `sonnet`, `haiku`, a `claude-*` ID, or the equivalent `anthropic/claude-*` form; omit it to use the CLI default. Convoy launches Claude with `--safe-mode`, disabling repository/user customizations such as `CLAUDE.md`, skills, plugins, hooks, and MCP servers, and exposes only the built-in read/search tools within the target and attached directories. Git-visible file, commit, or branch changes still fail the step but are left intact rather than deleted. Claude Code steps can't fan out across `models:` and stream their thinking/output/tool calls into the dashboard like any other step; their private raw event stream is written incrementally to `logs/<step>.<attempt>.claude.jsonl`, including failed attempts. Once a step finishes, `[o]` reopens its session interactively via `claude --resume --safe-mode` with the same tool envelope and full context. Claude Code is an **optional dependency**: only a pipeline that actually contains such a step requires the CLI, checked fail-fast at launch.
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

## Editing config interactively (`convoy config`)

`convoy config` opens a TUI to view and edit both configs without hand-editing YAML — two tabs, **Global** (`~/.convoy/config.yaml`) and **Project** (the current repo's `.convoy/config.yaml`):

- Pick OpenCode models from an autocompleting list: it queries enabled providers (including reasoning variants like `#xhigh`), falls back to [models.dev](https://models.dev), and accepts free-typed `provider/model[#variant]`. Claude Code steps use a runner-aware text editor for CLI aliases/IDs instead.
- Edit `defaults` and each agent's model, temperature, and tri-state `readOnly` override.
- Materialize built-in pipelines as editable overrides; add/delete pipelines; edit sequential and parallel steps, model fan-out, names, reports, diff behavior, and the step runner. Switching runner clears an incompatible model with confirmation, and Claude Code steps expose their read-only/no-fan-out constraints directly in the detail panel.
- When a tab has no file yet, `initialize` writes a starter config (the built-in `implement` pipeline, expanded and ready to edit).

Keys: `↑/↓` move, `enter` edit/expand, `tab` switch tab, `a` add, `d` delete, `shift+↑/↓` reorder, `t` agent temperature, `M` model fan-out, `g` group/ungroup, `n` step name, `r` reports or agent read-only, `R` step runner, `x` diff, `s` save, `q` quit. Saving re-validates and rewrites clean YAML (comments are not preserved); the dashboard never paints backgrounds, like the run TUIs. Needs an interactive terminal.

## Initializing config files (`convoy init`)

`convoy config` is interactive; `convoy init` is its non-interactive counterpart: it writes a commented starter config.

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
