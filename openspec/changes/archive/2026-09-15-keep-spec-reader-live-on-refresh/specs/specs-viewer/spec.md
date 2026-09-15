## ADDED Requirements

### Requirement: Open reading pane survives a background refresh

While the detail reading level is displayed, a scheduled or forced refresh SHALL re-derive the open subject and its artifact groups from the refreshed view and reload the active group's content before the pane is repainted, so the reading pane is never cleared to an empty body. The refresh SHALL preserve the operator's reading context — the active tab, the scroll position, and the fullscreen reader state. Content edited outside Convoy in the subject's checkout SHALL be reflected in the open pane within the refresh cadence. If the open subject is no longer present in the refreshed view, the browser SHALL return to the root list with the selection restored by identity rather than emptying the pane or silently retargeting to another subject. A failed refresh SHALL retain the current view and the loaded pane content.

#### Scenario: Scheduled refresh keeps the pane readable

- **WHEN** a change or canonical spec is open in the reading pane and a scheduled refresh runs
- **THEN** the pane still shows the active group's content afterwards, without a blank frame or an empty body

#### Scenario: External edit appears in the open pane

- **WHEN** an artifact of the open subject is edited on disk outside Convoy and a refresh runs within the cadence
- **THEN** the open pane shows the edited content without the operator leaving or re-entering the subject

#### Scenario: Reading context is preserved across a refresh

- **WHEN** a refresh runs while the operator is on a tab other than the first, scrolled down, or inside the fullscreen reader
- **THEN** the same tab is active, the scroll position is retained, and the fullscreen reader remains open

#### Scenario: Subject removed externally returns to the root

- **WHEN** a refresh runs and the open change or spec no longer exists in the refreshed view
- **THEN** the browser returns to the root list with the selection restored by identity, rather than leaving an empty reading pane

#### Scenario: Failed refresh keeps the pane

- **WHEN** a refresh fails to read the repository or checkout evidence
- **THEN** the previous view and the loaded reading-pane content remain displayed
