## ADDED Requirements

### Requirement: Close keeps its interface coherent across terminal-owned git effects

Interactive close SHALL suspend its alternate-screen interface around every operation whose git process inherits the terminal (the archive commit, the interrupted-archive reconcile commit, the squash candidate commit, and the hosted branch push) so that no git output is painted over the live interface, and SHALL resume with a full repaint before showing further progress or gates. The suspension SHALL cover the mutation itself, not just the commit message. Headless close SHALL be unaffected.

#### Scenario: Archive commit output does not corrupt the review

- **WHEN** interactive close archives selected changes and the archive commit inherits the terminal
- **THEN** the archive commit's output is isolated from the close interface, and the commit-message review that follows renders without git's commit subject or rename summary entangled with it

#### Scenario: Interrupted-archive reconcile commit stays isolated

- **WHEN** close reconciles an interrupted archive whose remaining step is the commit and that commit inherits the terminal
- **THEN** its output is isolated from the close interface and the following progress renders coherently

#### Scenario: Squash and hosted effects stay isolated

- **WHEN** interactive close lands locally or through the hosted path
- **THEN** the squash candidate commit and the branch push run outside the alternate screen and the interface repaints fully afterwards

### Requirement: Close releases input ownership before its completion notice

When interactive close reaches a successful or cancelled terminal state and a completion notice is presented in the shared session, the close screen SHALL remove its keyboard handling before the notice is shown so the notice receives `q`, Escape, Enter, and Ctrl+C and can be dismissed. The close screen SHALL NOT consume keys after the operation resolves.

#### Scenario: Completion notice is dismissible

- **WHEN** a close completes successfully and the shared session shows the close-complete notice
- **THEN** pressing `q`, Escape, Enter, or Ctrl+C dismisses the notice and returns control

#### Scenario: Cancellation notice is dismissible

- **WHEN** close is cancelled at the review gate and the cancellation notice is shown
- **THEN** the notice receives input and dismisses normally

#### Scenario: Failure surface still owns input

- **WHEN** interactive close stops with a failure
- **THEN** the failure surface stays readable and dismissible inside the close screen as before
