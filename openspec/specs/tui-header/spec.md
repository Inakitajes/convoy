# tui-header Specification

## Purpose

Defines the single-line header chrome shared by every destination screen of the home session — one bare content row that anchors the operator to the current context without any version or border chrome. The home launcher's own masthead is governed by the `home-launcher` capability.

## Requirements

### Requirement: Home-session destination screens draw one bare header row

The run launcher and the config editor SHALL draw their top chrome as exactly one content row with no border box and no panel title, and the body panels below SHALL reflow into the reclaimed vertical space without other layout changes. The specs browser and the runs browser SHALL draw no header row at all: they open directly on their rounded section containers, whose container headers carry the screen context, with screen identity supplied by the surrounding home session rather than a dedicated chrome row. The home launcher itself is out of scope: its masthead is defined by the `home-launcher` capability.

#### Scenario: Each destination renders its chrome anatomy

- **WHEN** the run launcher or config editor opens in a terminal
- **THEN** its top edge shows one header content row and no rounded border box, panel border title, or extra padding row above the body panels

#### Scenario: Section-container screens open without a header row

- **WHEN** the specs browser or the runs browser opens in a terminal
- **THEN** the board starts directly on its section containers with no dedicated header content row, and no screen-level `project` or `runs` label line exists

### Requirement: Header left-anchors a context label and value

Where a destination screen draws a header row, its content SHALL be left-anchored with a faint label, two spaces, and a text value, all truncated to fit the terminal width on one line. The run launcher SHALL use the label `project` and show the target project name. The config editor SHALL use the label `config` followed by the path of the active tab's config file (global or project), shortened relative to the home directory when applicable. The specs browser draws no header row at all. The runs browser's history statistics (`N runs · ✓ X · ✗ Y · $cost`, with live runs excluded from the completed/failed counts) SHALL live in its runs section container's header rather than a screen-level header row, and the runs browser SHALL NOT show its runs-root data directory or any "run history" caption anywhere in its chrome.

#### Scenario: Run launcher labels the target project

- **WHEN** the pipelines run launcher renders
- **THEN** the header reads `project  <project name>` followed by its step breadcrumb

#### Scenario: Runs browser shows stats in its section container

- **WHEN** the runs browser renders
- **THEN** the runs section container's header carries the stats summary (`N runs · ✓ X · ✗ Y · $cost`), and neither a data-root path nor a "Runs History" or "run history" caption appears anywhere in the chrome

#### Scenario: Config editor labels the active file

- **WHEN** the config editor renders
- **THEN** the header reads `config  <active tab path>` with the Global/Project tab strip as its right-aligned segment

### Requirement: Right-aligned header segments carry only screen-local context

When a screen's header row has a right-aligned segment, it SHALL carry only that screen's own working context — the config editor's tab strip, or the run launcher's step breadcrumb — and never global chrome like the convoy version. Screens without a header row (the specs browser and the runs browser) draw no right-aligned header segment at all; their right-aligned content, if any, belongs to their section containers and footers.

#### Scenario: Config tabs ride the header

- **WHEN** the config editor renders
- **THEN** the right end of the header line shows the Global/Project tab strip with the active tab emphasized, and the left end remains `config  <active tab path>`

#### Scenario: Run launcher breadcrumb rides the header

- **WHEN** the pipelines run launcher renders outside its review step
- **THEN** the right end of the header line shows the pipeline → prompt → options → (branch) → review breadcrumb, and the left end remains `project  <project name>`

#### Scenario: Container screens carry no header segment

- **WHEN** the specs browser or the runs browser renders
- **THEN** no screen-level header segment exists to carry right-aligned content

### Requirement: Headers carry no convoy version tag

No destination screen reachable from the home launcher — run launcher, specs browser, runs browser, or config editor — SHALL render a convoy-and-version tag (`convoy vX`, `convoy specs vX`, `◆ convoy vX · config`, or similar) in its header chrome. The header row and its border area SHALL contain only the context elements defined above; the version SHALL NOT appear in any of these headers. The home launcher's masthead build line is governed by the `home-launcher` capability.

#### Scenario: No version rides any header

- **WHEN** any of the four home-session destination screens renders
- **THEN** none of its header content, border titles, or header rows contain a convoy-plus-version string such as `convoy v`, `convoy specs v`, or `◆ convoy`

### Requirement: Fullscreen readers keep hiding the header

When the specs browser's fullscreen reader replaces the board chrome, the board's headers — section container headers rather than a screen-level header row — SHALL be absent from the frame alongside the footer and tab chrome.

#### Scenario: Fullscreen readers keep hiding the chrome

- **WHEN** the specs browser's fullscreen reader replaces the board chrome
- **THEN** the section containers' headers, the footer, and the tab chrome are absent from the frame
