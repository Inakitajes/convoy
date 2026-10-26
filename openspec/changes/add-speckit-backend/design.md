# Design

## Context

See `proposal.md`. Spec support has no seam today. The only shared pieces are `openspecDirName` (`src/openspec.ts:27`) and a handful of readers:

- Readers: `listChangeIds`, `loadOpenSpecBundle`, `readCheckoutActiveChanges`, `readCheckoutArchives`, `readCheckoutCanonicalSpecs`, `openspecTaskCounts`.
- About 35 modules call them directly or hard-code `openspec/`, `proposal.md`, `/opsx:propose`, or "OpenSpec" in text.
- The OpenSpec CLI is used in four places: `list --json` for task counts, `archive --help`, `archive <id> --yes`, and `validate --all`. Everything else reads files.

Spec Kit (v1.2.x) maps onto the same flow:

| OpenSpec | Spec Kit |
|---|---|
| change | feature |
| `proposal.md` | `spec.md` |
| `design.md` | `plan.md` |
| `tasks.md` | `tasks.md` |

Spec Kit has no delta specs, no merged canonical specs, and no archive. Its `specify` CLI only installs and manages integrations; it has no list, status, or validate. Spec Kit commands resolve the current feature from `SPECIFY_FEATURE_DIRECTORY`, then `.specify/feature.json`.

The precedent for a choice between tools is the runner descriptor table (`src/runners/descriptors.ts`, change `generalize-runner-routes`). Each runner is described once, and callers read the descriptor instead of comparing names.

## Goals / Non-Goals

**Goals:**

- Adding a spec tool means adding one descriptor and its reader module. Callers never compare tool names.
- OpenSpec behavior stays exactly as it is today, apart from the config value spelling.
- Spec Kit files are read directly. Convoy needs no `specify` binary.

**Non-Goals:**

- Running Spec Kit commands from Convoy, such as `/speckit-analyze` or `/speckit-converge`, as pipeline steps. Pipelines stay as they are; agents may still run the commands inside a step.
- Spec Kit extensions, presets, bug or assessment artifacts (`.specify/bugs/`, `.specify/assessments/`), and its MCP server.
- Using both tools in one project, or converting between formats.
- Removing the dead OpenSpec code the exploration found (`OpenSpecChange.touchedFiles`, `OpenSpecBundle.rootDir`, `feature-lifecycle/records.ts`). That cleanup belongs in its own change.

## Decisions

### D1. A spec tool descriptor table, modeled on runner descriptors

`src/spec-tools.ts` declares `specToolIds = ["openspec", "speckit"]` and one `SpecToolDescriptor` per tool. Its data fields:

- the change root (`openspec/changes`, `specs`)
- the dirty-path root spin tolerates (`openspec/`, `specs/`)
- labels ("OpenSpec change", "Spec Kit feature")
- `archives: boolean`
- proposal command names
- the reader's section groups
- the fingerprint roots

Its functions, implemented in `src/openspec.ts` and a new `src/speckit.ts`:

- `readActiveChanges`
- `readSettled`: OpenSpec archives, or completed Spec Kit features
- `readCanonical`: OpenSpec specs, or the Spec Kit constitution
- `loadBundle`
- `titleOf`
- `whyOf`
- `taskCounts`
- `branchPrefix`
- `stepEnv`

`specToolFor(config)` returns the descriptor, or `undefined` when specs are off. That replaces `featuresOf(config).specs` at every call site.

- **Alternative: an `interface` plus a class per tool.** Rejected. The repository already uses frozen descriptor tables for runners, and a class hierarchy adds instantiation for no state.
- **Alternative: `if (tool === "speckit")` branches at each call site.** Rejected. That is the pattern `generalize-runner-routes` removed.

### D2. Config spelling: `features.specs: openspec | speckit | false`

`validateFeatures` accepts the two ids or `false`. `FeatureToggles.specs` becomes `SpecToolId | false`, and `featuresOf` defaults it to `"openspec"`.

`true` is rejected rather than read as `openspec`. A second spelling of the same choice is the dual behavior the project avoids. The commented template and `docs/configuration.md` show the new values, so the break is one line to fix and the error message names it.

- **Alternative: a separate `specs.tool` key next to the boolean.** Rejected. Two keys can disagree (`specs: false`, `tool: speckit`), and one value cannot.

### D3. Completion stands in for archive under Spec Kit

A feature counts as active until its `tasks.md` has tasks and all of them are checked. This reuses the existing checkbox regex, which already matches `- [ ] T001 [P] [US1] …`.

Completed features fill the board's archive count slot and are browsable, read-only, the way OpenSpec archives are. Archive, the close archive selection, and recovery probes read `descriptor.archives`. When it is false, archive refuses before journaling, and close builds a plan with no archive step.

- **Alternative: Convoy moves completed features to `specs/archive/`.** Rejected. Spec Kit's own commands do not understand that directory, and the scripts' sequential numbering scans `specs/` and would still count it.

### D4. Bundle and step environment

`loadBundle` returns `SpecBundle { tool, changeIds, specFiles }`. For Spec Kit, `specFiles` is `.specify/memory/constitution.md` followed by `collectDirRelativeMarkdown` over each selected feature directory, reusing the walker that already skips dotfiles and symlinks.

`RunPlan.openspec` (`src/types.ts:383`, `src/run-plan.ts:32`) is renamed to `RunPlan.specs`. The "spec bundle is the contract" system-prompt sentence, `openSpecPromptFor`, and the review lines read the descriptor's labels.

The scorer, score-report, and scope prompts are static files with no placeholder substitution. Each one gets a short paragraph per tool: "when the contract is an OpenSpec change…" and "when it is a Spec Kit feature…". The system prompt's attachment sentence names the attached tool, so the model knows which paragraph applies. Adding a templating step for three prompts was rejected.

When exactly one Spec Kit feature is selected, `stepEnv` returns:

```
SPECIFY_FEATURE_DIRECTORY=<checkout>/specs/<id>
SPECIFY_FEATURE_NO_PERSIST=1
```

The runner merges this into the environment it already passes to step subprocesses. `NO_PERSIST` keeps a step from rewriting the operator's `.specify/feature.json`, which would otherwise show up as a repository change in verify phases.

### D5. Discovery of Spec Kit authoring commands

`findProposalCommand` takes the descriptor's ordered command names: `opsx-propose`, then `*propose`, for OpenSpec; `speckit.specify`, then `speckit-specify`, for Spec Kit.

`listClaudeAuthoringCommands` also lists `.claude/skills/<name>/SKILL.md` as `<name>`, because Spec Kit installs Claude integrations as skills. OpenCode discovery is unchanged: Spec Kit installs `.opencode/commands/speckit.*.md`, which the server API already lists.

### D6. Spin and branch prefix

The spin root and the dirty-path tolerance come from the descriptor. `branchPrefix` keeps `inferChangePrefix` for OpenSpec and returns `feat` for Spec Kit. `.specify/feature.json` is outside the moved tree, so spin never touches it.

## Risks / Trade-offs

- **[Risk] Spec Kit changes its layout or heading text.** The heading is `# Feature Specification:` and the input line is `**Input**: User description:`. → Title and Why fall back to the feature id and an omitted Why, never an error. Tests pin the v1.2 templates.
- **[Risk] A run resumed after the project switched tools.** The frozen `specs.tool` no longer matches the config. → The resume reads the frozen bundle's own tool, not the config, so its attachments stay what was reviewed.
- **[Risk] Features with no tasks stay active forever.** → This is intended: they are still being planned. The reader shows "tasks: none", so they are easy to spot.
- **[Trade-off] `--change` keeps the OpenSpec word.** Spec Kit users see "change" in the CLI and the picker. The labels in plan reviews and prompts say "Spec Kit feature".
- **[Trade-off] Breaking config spelling.** Projects that wrote `specs: true` must change it to `specs: openspec`. The template only ever showed `specs: true` as a commented line, so few files are affected.

## Migration Plan

Ship it in one release. The release notes name the `features.specs` spelling change. There is no data migration: frozen runs keep their tool through D4, and no on-disk Convoy state names the spec tool.
