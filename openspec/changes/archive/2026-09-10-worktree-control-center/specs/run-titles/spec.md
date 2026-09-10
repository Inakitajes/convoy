## MODIFIED Requirements

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
