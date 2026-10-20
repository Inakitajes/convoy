# Driving Convoy from an agent session

[Documentation](README.md) · [Convoy](../README.md)

Ask Claude Code, OpenCode, or Codex to run a pipeline for you, from the session you are already in. The pipeline's own steps can run on any of the three runners, whichever harness launched it.

- [Install the skill](#install-the-skill)
- [Pipeline commands](#pipeline-commands)
- [What the agent does](#what-the-agent-does)
- [OpenSpec changes](#openspec-changes)
- [Ad hoc pipelines](#ad-hoc-pipelines)
- [Safety](#safety)

## Install the skill

```bash
convoy skill install            # every harness found on this machine
convoy skill install --claude   # or name them: --claude, --opencode, --codex
```

The skill is a `SKILL.md` plus a pipeline-file reference, embedded in the Convoy binary and written to each harness's global skills directory:

| Harness | Directory |
|---|---|
| Claude Code | `~/.claude/skills/convoy` (`$CLAUDE_CONFIG_DIR`) |
| OpenCode | `~/.config/opencode/skills/convoy` (`$XDG_CONFIG_HOME`) |
| Codex | `~/.codex/skills/convoy` (`$CODEX_HOME`) |

Start a new session and ask for what you want ("run a Convoy review of this branch", "build a pipeline that audits the payments module with two model families and run it"). The harness loads the skill when the request matches it.

The installed skill describes the binary that installed it, so run `convoy skill install` again after `convoy update`; it refreshes stale copies and leaves current ones alone. `convoy skill show` prints the skill (`convoy skill show references/pipeline-files.md` the reference), which also works without installing it: point any agent at that output. `convoy skill uninstall` removes it and the pipeline commands. Convoy only refreshes or removes a `convoy` skill directory it wrote, recognized by the `<!-- convoy:skill -->` marker in its `SKILL.md`, and a command it wrote, recognized by `<!-- convoy:command -->`.

## Pipeline commands

`convoy skill install` also installs one slash command per built-in pipeline, a shortcut for "run this pipeline through the skill":

| Command | Runs | Changes code? |
|---|---|---|
| `/convoy-review` | `convoy -p review` | no |
| `/convoy-implement` | `convoy -p implement` | yes |
| `/convoy-full-cycle` | `convoy -p full-cycle` | yes |
| `/convoy-ship` | `convoy -p ship` | yes |
| `/convoy-fixer` | `convoy -p fixer` | yes |
| `/convoy-hunter` | `convoy -p hunter` | no |

Whatever follows the command is the request: a focus for a review (`/convoy-review the payments module`), the task to implement, the findings to fix, or an OpenSpec change id (`/convoy-implement add-login`). The agent then runs the usual loop below with the pipeline already chosen: plan, launch detached in the background, monitor, relay questions, report. A read-only pipeline launches straight after the plan, with `--yolo`; one that changes code waits for your go-ahead and runs with `--smart`. A project pipeline with the same name replaces the built-in, as it does for `convoy -p`.

Claude Code and Codex get them as user-invoked skills (`disable-model-invocation: true`) in the skills directory above, `~/.claude/skills/convoy-review/SKILL.md`; OpenCode as global commands, `~/.config/opencode/commands/convoy-review.md`. The `convoy-` prefix keeps them clear of the harnesses' own `/review` and of commands you wrote; a `convoy-<pipeline>` command without Convoy's marker is left untouched, and the install exits 1 to say so.

## What the agent does

The skill teaches a fixed loop on top of the [headless CLI](running.md#driving-convoy-from-a-script-or-agent):

1. **Discover.** `convoy pipelines` lists every runnable pipeline (built-in, global, project) and the agents a pipeline can use; `convoy pipelines show <name>` prints one pipeline's resolved steps: agent, model, runner, advisor, read-only, parallel groups, and goal loop. Both take `--json`.
2. **Choose or compose.** A built-in, a project pipeline, or a new [pipeline file](pipelines.md#pipeline-files) for the task, validated with `convoy pipelines show --pipeline-file <path>`.
3. **Pick the contract.** In an OpenSpec repository, the change to run against, or none ([below](#openspec-changes)).
4. **Plan.** It writes the prompt to a file, prints the resolved plan with `--plan`, and summarizes it for you before anything starts.
5. **Launch detached.** `convoy … --manual --yolo --detach < /dev/null` (`--smart` for a pipeline that writes code) returns `run <id> started` while the run continues in the background. The agent tells you the run id and roughly how long it takes, and the session stays yours.
6. **Monitor.** `convoy runs <id> --wait --timeout <n>`: in the background where the harness notifies the agent when a command exits (Claude Code), otherwise in short waits under the shell timeout, spaced to the run, with a progress line per wait. The exit code tells it whether the run completed (0), ended otherwise (1), is still going (2), or needs an answer (3).
7. **Relay questions.** A permission request the smart judge escalated is shown to you; the agent answers it with `convoy runs <id> approve|deny <request>` only after you decide.
8. **Report.** It reads `SUMMARY.md` and the reports, and tells you the outcome, score trajectory, cost, and where the work landed, with next steps (review the diff, `convoy publish --dry-run`, or `convoy --resume <id>` after a failure).

## OpenSpec changes

In a repository that uses [OpenSpec](openspec.md), every launch must name its contract: `--change <id>` (one or more active changes, attached to every step) or `--manual` (no change; the prompt is the brief). Convoy never picks one for you, and the skill doesn't either:

- If your request names a change (`/convoy-implement add-login`, "review this branch against add-login"), the agent passes `--change add-login`.
- If it doesn't, the agent lists the active changes under `openspec/changes/` with their proposal titles, points out the one that looks right (the one named like your branch, or the only one), and asks you: that change, others, or none (`--manual`).
- Without OpenSpec, or with `features.specs: false`, it passes `--manual`.

The plan it summarizes before launching names the attached changes on its `OpenSpec change:` line. With a change attached, the spec is the contract and no prompt is needed.

## Ad hoc pipelines

When no pipeline fits, the agent writes a pipeline file: the same mapping as a `pipelines.<name>` entry, plus an optional `name`, built from the agents `convoy pipelines` lists:

```yaml
name: payments-audit
steps:
  - agent: review-scope
    name: scope
    reports: none
    verify: true
  - parallel:
      - agent: security-reviewer
        name: security
        models: [openrouter/deepseek/deepseek-v4.1-flash-1017#high, openai/gpt-6.1-sol#high]
      - agent: hunter-reliability
        name: reliability
        models: [openrouter/deepseek/deepseek-v4.1-flash-1017#high, openai/gpt-6.1-sol#high]
  - agent: review-report
    name: report
    reports: all
```

```bash
convoy --pipeline-file payments-audit.yaml --prompt-file task.md --manual --yolo --detach < /dev/null
```

The file is validated exactly like a config pipeline and frozen into the run like any other, so `--resume` replays it. Your config files are never edited. A pipeline file can only use agents that already exist; adding a project agent stays your decision.

## Safety

The skill keeps you in the loop where it matters:

- It confirms the pipeline, what it will change, and that it bills your providers before launching. A read-only review you asked for by name needs no extra confirmation.
- It picks the permission mode from what the pipeline does. A read-only pipeline (`convoy pipelines show` says `read-only`) runs with `--yolo`: its steps can't edit the repository, the hard denylist still applies, and a step that changes the repository fails. A pipeline that writes code runs with `--smart`, never `--yolo` unless you ask for it. A mode you ask for wins.
- It never answers a permission request or publishes a pull request on its own.
- It doesn't edit `.convoy/config.yaml` or `~/.convoy/config.yaml` to run something once.

Everything else is Convoy's usual [permission policy](safety.md): the hard denylist, read-only enforcement, and the commit guards apply to every step, whoever launched the run. Runs with Claude Code or Codex steps need `runners.<id>.auth.billingPolicy: account-policy` set before an unattended launch ([Runners](runners.md#authentication-and-billing)); the agent will ask you to set it rather than doing it itself.

---

[Back to documentation](README.md)
