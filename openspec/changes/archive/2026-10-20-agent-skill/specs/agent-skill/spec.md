## ADDED Requirements

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
