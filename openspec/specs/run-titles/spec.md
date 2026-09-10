# run-titles Specification

## Purpose
Names a run for humans — in the runs browser and run history records — from the semantic context Convoy already holds (the attached change's proposal, the worktree branch), so a run launched from a spec pointer is never titled by the pointer prompt's first line.

## Requirements

### Requirement: Run titles follow a deterministic precedence

At run start Convoy SHALL resolve a human title from the first available source in this order: the first titled proposal in the accepted ordered list of explicitly selected active changes in the execution checkout; otherwise a humanized form of the run's actual branch name with the conventional prefix dropped and slug rendered as words; otherwise the prompt's first meaningful line. The selected local change list SHALL come only from the accepted run plan, not branch-to-change inference, feature associations, receipts, or same-id artifacts in another checkout. An empty list SHALL be valid only through the explicit manual/no-change launch mode; multiple selections SHALL retain operator-reviewed order without inventing an implicit composite title or contract set. A singleton suggestion SHALL not supply a proposal title until explicitly accepted. Selected artifact unavailability SHALL stop launch for correction rather than silently fall back; a readable proposal without a usable title MAY allow the next title source. The prompt's first line SHALL be used only when no usable selected proposal title or branch title exists. Title resolution MUST NOT require a model call. Human titles SHALL remain readable text with spaces, not filesystem or branch slugs; Worktrees branding SHALL NOT prohibit whitespace in titles. The resolved title SHALL continue to be persisted once at run start under the existing stable-title and legacy-readability guarantees.

#### Scenario: Run attached to a change is titled by the proposal

- **WHEN** a run on an unrelated branch explicitly selects a local change titled "Tabbed reading in the specs viewer"
- **THEN** that proposal title names the run rather than the branch slug or pointer prompt's first line

#### Scenario: Branch-named run without a change

- **WHEN** a run on `feat/quiet-notifications` explicitly uses manual/no-change mode and a matching change is present but unselected
- **THEN** the title is derived from the actual branch slug as "quiet notifications" without attaching or reading the unselected change as title authority

#### Scenario: Prompt-only run keeps the legacy fallback

- **WHEN** an explicit manual/no-change run has no usable branch title and its prompt's first meaningful line is "Refactor the retry loop"
- **THEN** that first meaningful line supplies the run title

#### Scenario: Multiple explicit selections have deterministic order

- **WHEN** the accepted run plan selects a change titled "Notification controls" before one titled "Report history"
- **THEN** the run title is "Notification controls" while both selections remain recorded in order without creating a composite change or asserting ownership

#### Scenario: Same-id proposals diverge across checkouts

- **WHEN** the execution checkout and launch directory contain different proposal titles for the same change id
- **THEN** only the explicitly selected execution-checkout proposal can supply the title

#### Scenario: Selected proposal is missing

- **WHEN** a proposal selected as launch input is missing or unreadable in the execution checkout
- **THEN** launch stops for correction instead of taking a title from another checkout or quietly substituting branch text for the unavailable selected input

#### Scenario: Readable proposal has no usable heading

- **WHEN** the first selected proposal is readable but untitled and the next explicitly selected proposal has a usable title
- **THEN** title resolution uses the next selected proposal in reviewed order without changing the selected list

### Requirement: Run titles are persisted and stable

The resolved title SHALL be persisted with the run's metadata at run start. Run discovery surfaces — the runs browser and run history records — SHALL prefer the persisted title. Once persisted, the title MUST NOT change during the run, after a goal-loop reset, or after workspace cleanup. Legacy run records persisted before this behavior SHALL remain readable: when no stored title exists, discovery SHALL fall back to the current first-heading-of-the-prompt derivation without rewriting the record.

#### Scenario: History survives workspace cleanup

- **WHEN** a completed run's workspace is cleaned up and the runs browser later lists it
- **THEN** the run displays its persisted title rather than a workspace-derived placeholder

#### Scenario: Prompt rewrite does not rename a live run

- **WHEN** a run's stored prompt document is rewritten during a goal-loop reset
- **THEN** the run's title stays the persisted one

#### Scenario: Legacy record without a stored title

- **WHEN** run discovery reads a run record that predates persisted titles
- **THEN** the run is titled by the prompt-document first-line fallback and the record is left unmodified
