# agent-skill Specification

## Purpose
TBD - created by archiving change agent-skill. Update Purpose after archive.

## Requirements

### Requirement: The binary carries the agent skill
Convoy SHALL embed the skill under `skills/convoy/` (a `SKILL.md` with `name` and `description` frontmatter followed by the `<!-- convoy:skill -->` marker, and its references), and `convoy skill show [file]` SHALL print `SKILL.md` or a named reference.

#### Scenario: Reading the skill without installing it
- **WHEN** an agent runs `convoy skill show`
- **THEN** it prints the embedded SKILL.md

### Requirement: The skill installs per harness
`convoy skill install [--claude] [--opencode] [--codex]` SHALL write the skill to `$CLAUDE_CONFIG_DIR|~/.claude/skills/convoy`, `$XDG_CONFIG_HOME|~/.config/opencode/skills/convoy`, and `$CODEX_HOME|~/.codex/skills/convoy`; without flags, to every harness whose config directory or binary is present, failing when none is. A current copy SHALL be left as is, a stale Convoy-written copy SHALL be replaced as a whole, and a `convoy` skill without the marker SHALL be left untouched and reported, exiting 1. `convoy skill uninstall` SHALL remove only Convoy-written copies.

#### Scenario: Refresh after an update
- **WHEN** the installed SKILL.md carries the marker but differs from the embedded one
- **THEN** the directory is replaced with the embedded files and reported as updated

#### Scenario: Someone else's convoy skill
- **WHEN** `~/.codex/skills/convoy/SKILL.md` exists without the marker
- **THEN** install and uninstall leave it unchanged and say so

### Requirement: Pipeline commands install with the skill
`convoy skill install` SHALL install, for each harness it installs the skill for, one `convoy-<pipeline>` command per pipeline in `pipelineCommands` (`review`, `implement`, `full-cycle`, `ship`, `fixer`, `hunter`): a user-invoked skill (`name`, `description`, `argument-hint`, `disable-model-invocation: true`) at `<skills dir>/convoy-<pipeline>/SKILL.md` for Claude Code and Codex, and `commands/convoy-<pipeline>.md` beside the skills directory for OpenCode, each carrying the `<!-- convoy:command -->` marker after its frontmatter. Each command SHALL launch `convoy -p <pipeline>` through the skill's headless loop with `$ARGUMENTS` as the request. A current command SHALL be left as is, a stale Convoy-written one replaced, a Convoy-written command for a pipeline no longer listed removed, and a command of the same name without the marker left untouched and reported, exiting 1. `convoy skill uninstall` SHALL remove every Convoy-written `convoy-*` command and nothing else.

#### Scenario: A shortcut for the review pipeline
- **WHEN** the user types `/convoy-review the payments module` in a session with the commands installed
- **THEN** the agent plans and launches `convoy -p review` detached with that focus, and follows it to a report

#### Scenario: An operator's own command
- **WHEN** `~/.config/opencode/commands/convoy-ship.md` exists without the marker
- **THEN** install leaves it unchanged, installs the other commands, reports it, and exits 1

### Requirement: The skill asks for the OpenSpec contract
In a repository with active OpenSpec changes, the skill and every pipeline command SHALL pass `--change <id>` for each change the user named, in their order, and otherwise SHALL list the active changes and ask the user whether to run against one (suggesting the change named like the branch, or the only one), several, or none (`--manual`). They SHALL NOT select a change or fall back to `--manual` without asking. Without OpenSpec, or with specs off, they SHALL pass `--manual`.

#### Scenario: No change named
- **WHEN** the user types `/convoy-implement` on branch `feat/add-login` and `openspec/changes/` holds `add-login` and `fix-typo`
- **THEN** the agent lists both, suggests `add-login`, and waits for the user's choice before planning
