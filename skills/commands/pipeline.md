Run the Convoy `{{pipeline}}` pipeline from this session, headless: {{summary}}

Request: $ARGUMENTS

Follow the `convoy` skill for every step (load it now if it isn't loaded; `convoy skill show` prints it). This command only fixes the pipeline to `{{pipeline}}`, launched as `convoy -p {{pipeline}}`; everything else works as the skill says.

1. **Inspect.** In the repository this session works in, run `convoy pipelines show {{pipeline}}`. A project pipeline of the same name replaces the built-in, so describe what will actually run. Its first line says `read-only` or `writes code`; that, not the name, sets the permission mode below.
2. **Choose the contract.** If the repository has active OpenSpec changes (the directories under `openspec/changes/` other than `archive/`), follow "Choose the contract" in the skill: a change id named in the request becomes `--change <id>` (repeatable, in that order); otherwise list the active changes, say which one fits (the one named like the current branch, or the only one), and ask the user whether to run against it, against others, or without one (`--manual`). Never pick a change or fall back to `--manual` without asking. Without OpenSpec, pass `--manual`.
3. **Prompt.** {{prompt}}
4. **Plan.** `convoy -p {{pipeline}} <--change <id> … | --manual> [--prompt-file <file>] <--yolo | --smart> --plan < /dev/null`, then summarize the plan for the user. {{permissions}}
5. **Launch.** {{launch}} Launch the same command with `--detach` in place of `--plan` (never without it) and keep the run id.
6. **Follow it through.** Follow the run in the background as the skill's section 6 describes, so this session stays free: tell the user the run id and roughly how long it takes, then check back at the cadence the run calls for. Relay anything it asks and report the results, as sections 7 and 8 describe.
