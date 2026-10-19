# Driving Convoy from an agent session

[Documentation](README.md) · [Convoy](../README.md)

Ask Claude Code, OpenCode, or Codex to run a pipeline for you, from the session you are already in.

- [Install the skill](#install-the-skill)
- [What the agent does](#what-the-agent-does)
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

The installed skill describes the binary that installed it, so run `convoy skill install` again after `convoy update`; it refreshes stale copies and leaves current ones alone. `convoy skill show` prints the skill (`convoy skill show references/pipeline-files.md` the reference), which also works without installing it: point any agent at that output. `convoy skill uninstall` removes it. Convoy only refreshes or removes a `convoy` skill directory it wrote, recognized by the `<!-- convoy:skill -->` marker in its `SKILL.md`.

## What the agent does

The skill teaches a fixed loop on top of the [headless CLI](running.md#driving-convoy-from-a-script-or-agent):

1. **Discover.** `convoy pipelines` lists every runnable pipeline (built-in, global, project) and the agents a pipeline can use; `convoy pipelines show <name>` prints one pipeline's resolved steps: agent, model, runner, advisor, read-only, parallel groups, and goal loop. Both take `--json`.
2. **Choose or compose.** A built-in, a project pipeline, or a new [pipeline file](pipelines.md#pipeline-files) for the task, validated with `convoy pipelines show --pipeline-file <path>`.
3. **Plan.** It writes the prompt to a file, prints the resolved plan with `--plan`, and summarizes it for you before anything starts.
4. **Launch detached.** `convoy … --manual --smart --detach < /dev/null` returns `run <id> started` while the run continues in the background.
5. **Monitor.** `convoy runs <id> --wait --timeout <n>` in a loop, sized to the harness's shell timeout, with a progress line per wait. The exit code tells it whether the run completed (0), ended otherwise (1), is still going (2), or needs an answer (3).
6. **Relay questions.** A permission request the smart judge escalated is shown to you; the agent answers it with `convoy runs <id> approve|deny <request>` only after you decide.
7. **Report.** It reads `SUMMARY.md` and the reports, and tells you the outcome, score trajectory, cost, and where the work landed, with next steps (review the diff, `convoy publish --dry-run`, or `convoy --resume <id>` after a failure).

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
        models: [openrouter/deepseek/deepseek-v4.1-flash#high, openrouter/z-ai/glm-5.3-flash#high]
      - agent: hunter-reliability
        name: reliability
        models: [openrouter/deepseek/deepseek-v4.1-flash#high, openrouter/z-ai/glm-5.3-flash#high]
  - agent: review-report
    name: report
    reports: all
```

```bash
convoy --pipeline-file payments-audit.yaml --prompt-file task.md --manual --smart --detach < /dev/null
```

The file is validated exactly like a config pipeline and frozen into the run like any other, so `--resume` replays it. Your config files are never edited. A pipeline file can only use agents that already exist; adding a project agent stays your decision.

## Safety

The skill keeps you in the loop where it matters:

- It confirms the pipeline, what it will change, and that it bills your providers before launching. A read-only review you asked for by name needs no extra confirmation.
- It launches with `--smart`, never `--yolo` unless you ask for it.
- It never answers a permission request or publishes a pull request on its own.
- It doesn't edit `.convoy/config.yaml` or `~/.convoy/config.yaml` to run something once.

Everything else is Convoy's usual [permission policy](safety.md): the hard denylist, read-only enforcement, and the commit guards apply to every step, whoever launched the run. Runs on Claude Code steps need `defaults.claudeAuth.billingPolicy` set before an unattended launch ([Runners](runners.md)); the agent will ask you to set it rather than doing it itself.

---

[Back to documentation](README.md)
