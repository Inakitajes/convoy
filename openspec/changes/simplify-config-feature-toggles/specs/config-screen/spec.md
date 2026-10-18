## ADDED Requirements

### Requirement: The config screen lists the files that shape the project
`convoy config` and the TUI's Config destination SHALL list, for the global scope and then the project scope, the scope's config file (the first of `config.yaml` or `config.yml` that exists, else the default name) and every agent prompt override in that scope's `agents/` directory. Each config file SHALL show whether it exists and whether it loads, with the parser's error when it does not. Listing SHALL NOT write any file, including the global loader's in-place migrations.

#### Scenario: A config that does not load
- **WHEN** the global config has an invalid value
- **THEN** its row says it doesn't load and the parser's error is shown, and the file is left unchanged

#### Scenario: No project config yet
- **WHEN** the project has no `.convoy/config.yaml` or `.convoy/config.yml`
- **THEN** the project row shows the default path as not created

### Requirement: Files open in the operator's editor
Opening a row SHALL run the editor in the foreground with the file as its last argument: `$VISUAL`, else `$EDITOR` (split on whitespace so arguments are kept), else the first of `nano`, `vim`, or `vi` on `PATH`. Opening a missing config file SHALL first create it from the `convoy init` template. When the editor exits, the screen SHALL load the file again and report whether it still loads, or the editor's non-zero exit code. Convoy SHALL NOT edit configuration values itself.

#### Scenario: An edit breaks the config
- **WHEN** the operator saves a value the parser rejects and closes the editor
- **THEN** the screen reports that the file no longer loads, with the error

#### Scenario: No editor available
- **WHEN** neither `$VISUAL` nor `$EDITOR` is set and none of `nano`, `vim`, `vi` is on `PATH`
- **THEN** the screen says to set `$EDITOR` and opens nothing
