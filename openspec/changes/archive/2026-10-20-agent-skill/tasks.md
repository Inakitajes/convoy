# Tasks

## 1. Headless surface

- [x] 1.1 Add `--detach` to launches: return after the coordinator is ready, keep the pending log, imply no dashboard, confirmation, or human steps; verify `test/cli-parser.test.ts`.
- [x] 1.2 Add `convoy runs --json`, `--wait`, and `approve|deny|abort` in `src/runs-command.ts`, with `loadRun` and `probeRunPending` in `src/runs.ts`; verify `test/runs-command.test.ts`.
- [x] 1.3 Add `--pipeline-file` with `parsePipelineFile`/`loadPipelineFile` in `src/config.ts`; verify `test/pipelines-command.test.ts` and `test/cli-parser.test.ts`.
- [x] 1.4 Add `convoy pipelines [show]` in `src/pipelines-command.ts`; verify `test/pipelines-command.test.ts`.

## 2. Agent skill

- [x] 2.1 Write `skills/convoy/SKILL.md` and `references/pipeline-files.md`; validate every example with `convoy pipelines show --pipeline-file`.
- [x] 2.2 Add `convoy skill install|uninstall|show` in `src/skill-install.ts`; verify `test/skill-install.test.ts`.
- [x] 2.3 Exercise the loop end to end: a detached Claude Code run, `--wait`, `--json`, a permission answered with `deny` and `approve`, and `abort`.

## 3. Documentation

- [x] 3.1 Add `docs/agents.md`; update `docs/running.md`, `docs/pipelines.md`, `docs/development.md`, `docs/README.md`, `README.md`, and `--help`.
