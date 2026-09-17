## ADDED Requirements

### Requirement: External pane presentation hosts the client in the operator's shell

When Convoy opens a harness client in a multiplexer pane, it SHALL host that client inside the operator's normal interactive shell, loading the shell's login and interactive startup configuration rather than suppressing it. The pane's requested working directory and any Convoy-supplied environment SHALL still be applied, but the operator's own startup configuration SHALL remain authoritative for environment resolution such as `PATH`, so a harness command resolves to the same executable it would in the operator's own shell. After the harness client exits, the pane SHALL present a normal interactive shell rather than an unconfigured one. Convoy SHALL submit the client command only once the shell is ready to receive it, so shell startup output cannot cause the command to be lost, duplicated, or run before the interactive shell is usable.

#### Scenario: Multiplexer pane loads the operator's shell startup

- **WHEN** Convoy opens a harness client in a supported multiplexer pane
- **THEN** the pane shell runs the operator's login and interactive startup configuration, with the requested working directory and Convoy-supplied environment applied

#### Scenario: Launched client resolves as in the operator's shell

- **WHEN** the operator's shell resolves the harness executable to a specific path
- **THEN** the pane resolves and runs the same executable instead of a different one that the operator's environment would not have selected

#### Scenario: Exiting the client leaves a normal interactive shell

- **WHEN** the harness client exits in the pane
- **THEN** the pane presents the operator's normal interactive shell, with the operator's prompt and configuration, rather than an unconfigured shell

#### Scenario: Command submission tolerates shell startup output

- **WHEN** the pane shell emits startup output before it becomes interactive
- **THEN** Convoy still submits the client command exactly once, after the shell is ready, without losing or duplicating it
