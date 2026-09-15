## ADDED Requirements

### Requirement: Archive picker offers ordered batch selection

The interactive archive picker SHALL let the operator select one or more of the checkout's active changes before confirming: toggling the highlighted row marks or unmarks that change, a select-all action marks every active change, and the confirmed batch is ordered by the picker's active-change listing. Confirming with no change marked SHALL NOT archive anything. The confirmed batch SHALL be handed to the archive command as the reviewed ordered batch and journaled per change.

#### Scenario: Several changes archived as one batch

- **WHEN** the operator marks two active changes and confirms
- **THEN** both are archived in the picker's listing order and committed as one verified archive commit

#### Scenario: Select-all archives every active change

- **WHEN** the operator invokes select-all and confirms
- **THEN** every active change in the checkout is archived in listing order

#### Scenario: Nothing marked does not archive

- **WHEN** the operator confirms with no change marked
- **THEN** no archive runs and the picker does not report a success
