# Proposal

## Why

With the skill installed, running a built-in pipeline from an agent session still means describing it in prose ("run a Convoy review of this branch…"). A slash command per pipeline makes the common case one word. And in a repository that uses OpenSpec, the skill told agents to pass `--manual` in every example, so a run from an agent session quietly skipped the spec contract the launcher would have offered.

## What Changes

- `convoy skill install` also installs one command per built-in pipeline: `/convoy-review`, `/convoy-implement`, `/convoy-full-cycle`, `/convoy-ship`, `/convoy-fixer`, `/convoy-hunter`. Each runs `convoy -p <pipeline>` through the skill's headless loop, with whatever follows the command as the request. Claude Code and Codex get user-invoked skills (`disable-model-invocation: true`), OpenCode global commands in `commands/`. `convoy skill uninstall` removes them.
- The skill gains a "Choose the contract" step: list the active OpenSpec changes, use the ones the user named, otherwise ask (suggesting the branch-named or only change) between a change and `--manual`. It never picks silently.
- `docs/openspec.md` describes selection as explicit, matching the launch code (the auto-resolution list it carried was stale).

## Capabilities

### Modified Capabilities

- `agent-skill`: pipeline commands and the OpenSpec contract step.

## Impact

- New: `skills/commands/pipeline.md` (the command template).
- Changed: `src/skill-install.ts`, `skills/convoy/SKILL.md`, `test/skill-install.test.ts`.
- Docs: `docs/agents.md`, `docs/openspec.md`, `README.md`.
