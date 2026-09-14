# Development guide

[Documentation](README.md) · [Convoy](../README.md)

Build Convoy, run checks, and find the main source modules.

- [Development](#development)
- [Structure](#structure)

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Structure

```
convoy/
├── src/
│   ├── main.ts          # entrypoint
│   ├── cli.ts           # flag parsing
│   ├── runner.ts        # pipeline orchestration
│   ├── opencode.ts      # startup/control via SDK
│   ├── agents.ts        # prompt loading, agent config, bash policy
│   ├── project-context.ts # automatic .convoy/rules.md, AGENTS.md, CLAUDE.md discovery
│   ├── permissions.ts   # live permission gate for tool calls that fall outside the allowlist
│   ├── safety-judge.ts  # external AI judge for smart auto-accept (tool-less, fail-closed)
│   ├── advisor.ts       # the advisor consultation: tool-less, over the executor's transcript, output-capped
│   ├── advisor-runtime.ts # per-run advisor policy: session→phase, budget, first-write checkpoint
│   ├── advisor-bridge.ts  # loopback endpoint + the custom `advisor` tool the executor calls on demand
│   ├── advisor-report.ts  # executor/advisor token split read back from the attempt logs
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff, commit, and pre-commit secret scan
│   ├── worktree-commands.ts  # the worktree control center's guarded CLI/TUI operations, incl. close
│   ├── close-journal.ts  # legacy close journal/receipt reading and evidence refs in the git common dir
│   ├── close-tui.ts      # close's full-screen checklist TUI
│   ├── publish.ts        # the deliberate Create pull request action: normal push, then locate/create PR
│   ├── finalization/    # guarded automatic run compaction: interval, lease, refs, executor
│   ├── commit-message.ts # writes the conventional commit message compaction and close propose
│   ├── step-commit.ts    # intermediate convoy(<step>) messages with a Convoy-Run trailer
│   ├── workspace.ts     # run dir, ~/.convoy home (CONVOY_HOME), global config/agents paths
│   ├── runs.ts          # interactive run-history browser (convoy runs)
│   ├── runs-tui.ts      # OpenTUI run-history browser rendering
│   ├── metadata.ts      # per-run metadata.json: frozen pipeline + --resume restore
│   ├── config.ts        # config loader/validation, global+project merge, YAML writer
│   ├── config-tui.ts    # interactive config editor (convoy config)
│   ├── model-catalog.ts # available-model list via OpenCode SDK, models.dev fallback
│   ├── version.ts       # injected version/commit/platform + --version and TUI header formatting
│   ├── update.ts        # GitHub Releases update check + verified atomic self-install
│   └── pipeline.ts      # built-in agents/pipeline and pipeline-spec resolution
├── scripts/             # build.ts: local + multi-target release binary compilation
├── prompts/             # built-in agent prompts and runtime safety guard rails
├── test/                # unit tests for CLI/orchestration
├── .github/workflows/   # release.yml: tag-triggered build, test, and GitHub Release publish
├── package.json
├── tsconfig.json
└── Makefile
```

---

[Back to documentation](README.md)
