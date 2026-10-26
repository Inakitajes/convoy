## MODIFIED Requirements

### Requirement: Archive acts only on selected local changes
Archive SHALL invoke the supported OpenSpec workflow in the explicitly selected checkout on the explicitly selected active change, or an explicitly reviewed ordered batch. It SHALL display tasks and artifact availability, refuse missing/unreadable targets, require clean tracked/untracked state for its managed commit, and never archive every directory by discovery alone. Incomplete or unknown tasks SHALL block ordinary archive; an explicit warning/override SHALL be offered only if supported by OpenSpec and SHALL never imply implementation validation. Convoy SHALL inspect the actual OpenSpec output and changed paths, respect the CLI's archive naming, and commit only verified archive output under the operator's signing/hooks. Errors or unrelated changes SHALL stop before commit. External archive/delete SHALL simply change the next local listing; absence alone SHALL NOT count as a completed pending archive. Archived files SHALL remain inspectable without reactivating them. When the configured spec tool has no archive support (Spec Kit), archive SHALL refuse before any effect, naming that reason.

#### Scenario: An inherited change is present
- **WHEN** a checkout contains selected change A and inherited change B
- **THEN** archiving A does not archive, attach, hide, or require completion of B

#### Scenario: Archive was performed outside Convoy
- **WHEN** OpenSpec moves a change into a dated archive directory outside Convoy
- **THEN** refresh shows the local archive and no association repair, branch rename, or lifecycle update is required
#### Scenario: Archive modifies unrelated files

- **WHEN** an archive attempt leaves changes outside its verified output
- **THEN** Convoy preserves the files, stops before an automatic commit, and explains the recovery requirement

#### Scenario: Archive under Spec Kit

- **WHEN** archive is requested for a Spec Kit feature
- **THEN** Convoy refuses before journaling or running any command, names that Spec Kit has no archive, and the feature directory is unchanged
