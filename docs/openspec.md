# Spec-tool workflows

[Documentation](README.md) · [Convoy](../README.md)

Use OpenSpec or GitHub Spec Kit as the contract for implementation and review. Convoy reads their files directly; it needs no `specify` CLI for Spec Kit runs.

- [Choose one spec tool](#choose-one-spec-tool)
- [Selecting the contract](#selecting-the-contract)
- [OpenSpec-native runs](#openspec-native-runs)
- [Spec Kit runs](#spec-kit-runs)
- [The specs reader (`convoy specs`)](#the-specs-reader-convoy-specs)
- [Authoring and lifecycle](#authoring-and-lifecycle)

## Choose one spec tool

Set `features.specs` in the global or project Convoy config; the project value wins, and an unset value defaults to `openspec`:

```yaml
features:
  specs: speckit   # openspec (default), speckit, or false
```

`true` is rejected: replace `specs: true` with `specs: openspec`. Convoy never auto-detects the tool from files, reads the other layout as a fallback, or combines layouts. An absent configured root means no changes, even if the other tool's files exist. With `features.specs: false`, there is no picker or spec bundle and no requirement for `--change` or `--manual`; spec commands refuse ([Configuration](configuration.md#turning-off-worktrees-or-specs-features)).

## Selecting the contract

Selection is explicit: a run's change comes from `--change <id>` (repeatable, in review order) or from the launcher, never from discovery. Spec Kit feature ids keep the same `--change` vocabulary. Nothing auto-attaches the only active change, one named like the branch, or the changes the diff touches. When the configured tool's layout is present, a headless launch must say which contract to use:

- `--change <id>` (one or more): every id must name an active change of the configured tool; missing, archived, or completed ids refuse.
- `--manual`: an explicit no-change run, driven by the prompt (or the pipeline's default prompt).
- Neither: the launch refuses with change-selection guidance. With no active changes, the hint names the configured tool's authoring command or `--manual`.

The launcher lists the configured tool's active changes: pick one and the spec is the contract (no prompt required), or choose **Manual prompt**. From an agent session, the [Convoy skill](agents.md#spec-tool-changes) first resolves the global/project tool choice, lists only that tool's active changes, and asks you to choose one, several, or none. Naming changes in your request skips that question; suggestions never count as selection.

```bash
convoy
convoy --change add-login -p implement     # features.specs: openspec
convoy --change 001-login -p review       # features.specs: speckit
convoy --manual -p review                 # explicitly without a change
```

A resumed run keeps its frozen bundle and the bundle's own tool, even if the project changes tools later.

## OpenSpec-native runs

With `features.specs: openspec`, Convoy reads [OpenSpec](https://openspec.dev/) contracts from:

```text
openspec/
  changes/<id>/           proposal.md · specs/** · design.md · tasks.md
  changes/archive/<id>/   archived changes, excluded from selection
  specs/<capability>/     spec.md
```

Active changes are real directories directly under `openspec/changes/`, excluding `archive`, hidden entries, symlinks, and stray files. Convoy attaches the **spec bundle** — current `openspec/specs/**` plus each selected change's Markdown artifacts — to **every agent step**. The `prd` (30%) and `scope` (10%) quality dimensions use **Requirements/Scenarios** and ADDED/MODIFIED/REMOVED delta operations, not a diff-inferred brief. Authoring and archive transformations belong to OpenSpec's workflow, not hand-written Convoy migrations.

## Spec Kit runs

With `features.specs: speckit`, Convoy reads [GitHub Spec Kit](https://github.com/github/spec-kit):

```text
.specify/memory/constitution.md
specs/<id>/
  spec.md · plan.md · tasks.md
  research.md · data-model.md · quickstart.md
  contracts/** · checklists/**
```

A feature is a real directory directly under `specs/` containing `spec.md`; its id is the directory name verbatim (for example, `001-login`). Hidden entries, symlinks, stray files, and directories without `spec.md` are ignored; ids are sorted. Features stay **active** if `tasks.md` is missing, empty, unreadable, or has any unchecked task. **Completed** means at least one checkbox task and every task checked (`[x]` or `[X]`); completed features are excluded from run, spin, and Propose follow-up selection. Counts come directly from checkbox lines, including `- [ ] T001 [P] [US1] …`; unreadable task counts remain unknown.

The **spec bundle** is the constitution (when present), followed by **every Markdown file** under each selected feature directory in selection order, including nested `contracts/` and `checklists/`, plus the text contracts in other formats under `contracts/` (OpenAPI or JSON Schema in YAML/JSON, GraphQL, protobuf). Binary and hidden files are skipped. Every agent step receives it; no other feature is attached. The `prd` and `scope` dimensions use **user-story acceptance scenarios** and **`FR-`/`SC-` ids**. Spec Kit has no delta operations or merged canonical specs. Titles strip `Feature Specification:` from the spec's heading (falling back to the id); the PR body's Why comes from `**Input**: User description:` and is omitted when absent.

With **exactly one selected feature**, every agent step receives:

```text
SPECIFY_FEATURE_DIRECTORY=<checkout>/specs/<id>
SPECIFY_FEATURE_NO_PERSIST=1
```

The directory is absolute in the run's checkout. `SPECIFY_FEATURE_NO_PERSIST=1` keeps commands inside a step from rewriting `.specify/feature.json`. With zero or multiple selected features, Convoy sets **neither** variable. Convoy does not run Spec Kit commands as pipeline steps; agents may use installed commands within a step.

## The specs reader (`convoy specs`)

```bash
convoy specs     # the artifact-focused reader entry
convoy control   # opens the worktree control board instead
```

The reader uses the same Git worktree inventory as the control board, even with no spec files. Without a selected checkout it shows Worktrees; with one selected it opens that checkout's local artifacts. Only the configured tool is read; empty sections are omitted and unreadable evidence stays unknown:

- **Active Changes** — active OpenSpec changes or Spec Kit features, with tasks done/total (or unknown), artifact availability, and independent Git observations. Same-id copies in different checkouts stay independent; file presence is never ownership.
- **Archived/completed count** — local OpenSpec archives or completed Spec Kit features appear as counts in the board and plain listing, not browsable board sections.
- **Canonical context** — OpenSpec's `openspec/specs/**`, or Spec Kit's `.specify/memory/constitution.md` when present.

Enter a change or canonical document to read it in a full-width pane. OpenSpec tabs are **Proposal, Design, Tasks, Delta Specs** (merged with per-capability headings), and **Other**. Spec Kit tabs are **Spec, Plan, Tasks, Design Docs** (`research.md`, `data-model.md`, `quickstart.md`, and `contracts/**`, merged with per-file headings), and **Other** (including checklists). Only present groups appear; a single group hides the strip. Switch with `←`/`→` (`h`/`l`) or digits `1`–`9`, scroll with `↑`/`↓`, use `v` for fullscreen, `c` to copy its active Markdown tab, and `q` to leave. The header names the target project; canonical selection hides the redundant details preview.

Row actions act on the explicitly selected checkout-local change:

- **`a` — apply** hands the change to the launcher with its checkout-local source preselected.
- **`i` — iterate** opens (or resumes) an authoring conversation on the planning files in their checkout.
- **archive** — supported only for OpenSpec; the action remains visible but disabled under Spec Kit with **"Spec Kit has no archive"**.
- **`x` — close review** opens the close confirmation for the containing worktree ([Worktrees and delivery](worktrees.md#closing-a-worktree-convoy-close)).

## Authoring and lifecycle

**Propose** uses the configured tool's installed command: `opsx-propose` (then another command ending in `propose`) for OpenSpec; `speckit.specify`, then `speckit-specify`, for Spec Kit. Claude discovery also reads `.claude/skills/<name>/SKILL.md`; OpenCode uses the commands exposed by its server, including `.opencode/commands/speckit.*.md`. If no supported command exists, Convoy names what it looked for and leaves ordinary conversation usable; it never silently installs a workflow.

**Spin** moves only the selected uncommitted tool directory: `openspec/changes/<id>/` or `specs/<id>/`. Spec Kit's branch prefix defaults to `feat`; `.specify/` stays untouched, including `.specify/feature.json`. Dirt outside the configured tool's root blocks spin.

**Archive** is unavailable for Spec Kit: `convoy worktrees archive` refuses with "Spec Kit has no archive" before any effect, without moving, renaming, or deleting a feature. **Close** offers no Spec Kit archive selection; its reviewed operations are sync and whole-branch squash only. Feature directories remain in place; completion comes from tasks, not an invented `specs/archive/`. See [spin and close](worktrees.md).

---

[Back to documentation](README.md)
