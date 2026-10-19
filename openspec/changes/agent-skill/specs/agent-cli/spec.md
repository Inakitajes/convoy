## ADDED Requirements

### Requirement: A launch can detach
`--detach` SHALL start the run's coordinator, print `run <id> started (coordinator <pid>, detached)` followed by the coordinator's log path, and exit 0 once the coordinator reports ready, leaving the run executing. It SHALL imply no dashboard, no interactive confirmation, and no human steps unless `--human-step` is passed. It SHALL be refused together with `--tui` or `--plan`.

#### Scenario: Detached launch from an agent shell
- **WHEN** `convoy --pipeline review --manual --smart --detach < /dev/null` runs
- **THEN** it prints the plan and `run <id> started …`, exits 0, and the run continues to completion

### Requirement: A run's state is available as data
`convoy runs <id> --json` SHALL print one JSON object with the run's `state` (`running`, `waiting`, `completed`, `failed`, `incomplete`, or `unknown`), status text, phases, cost, goal, finalization, `summaryPath` when SUMMARY.md exists, `reports` (every phase report path), `targetDir`, and, while the run is live, `waiting` (the pending permission request or human gate) and `logPath` when the coordinator's log is still present. `convoy runs --json` SHALL print the history as a JSON array without probing gates.

#### Scenario: A run waiting for a permission
- **WHEN** a live run's head permission request is `bash: npm publish`
- **THEN** `--json` reports `state: "waiting"` and `waiting` with its `requestId`, `permission`, `command`, and `patterns`

### Requirement: A caller can wait for a run
`convoy runs <id> --wait [--timeout <duration>]` SHALL poll the run until it is no longer running, waits at a gate, or the timeout (default 5 minutes) passes. In text mode it SHALL print each phase status change as it is observed and end with the run's status and the next command; with `--json` it SHALL print only the final snapshot. It SHALL exit 0 when the run completed, 1 when it ended otherwise, 2 when the timeout passed while running, and 3 when the run waits for an answer.

#### Scenario: Timeout while running
- **WHEN** the run is still executing when the timeout passes
- **THEN** the command exits 2 and prints how to wait again

### Requirement: A detached run can be answered from the CLI
`convoy runs <id> approve <request-id> [--always]`, `deny <request-id>`, and `abort` SHALL claim the run's controller slot, act, and release it. Approve and deny SHALL refuse unless `<request-id>` is the pending permission request. All three SHALL refuse while another controller holds the slot, and when the run is not live.

#### Scenario: Approving a request that changed
- **WHEN** the caller approves `p1` but the run now waits on `p2`
- **THEN** nothing is answered and the error names `p2`

### Requirement: A pipeline can come from its own file
`--pipeline-file <path>` SHALL load a YAML mapping with the keys of a `pipelines.<name>` entry plus an optional `name` (default: the file's basename without extension), validate it with the config pipeline rules, and run it as the run's pipeline, frozen into its metadata. It SHALL be refused together with `--pipeline` or `--resume`, and a reserved or unsafe name SHALL be refused.

#### Scenario: Composing without touching config
- **WHEN** an agent runs `convoy --pipeline-file /tmp/audit.yaml --manual --smart --detach`
- **THEN** the run executes the file's steps and no config file changes

### Requirement: The pipeline catalog is listable
`convoy pipelines` SHALL list every runnable pipeline with its source (built-in, global, or project; project shadowing global shadowing built-in), whether it writes code, its runners (any registered runner, including mixed fan-outs), its goal target, and which is the default, followed by the agent registry. `convoy pipelines show <name>` and `show --pipeline-file <path>` SHALL print the resolved steps (agent, model, runner, advisor, read-only, verify, parallel group) and the goal loop. Both SHALL accept `--json`.

#### Scenario: Validating a pipeline file
- **WHEN** `convoy pipelines show --pipeline-file p.yaml` names a file with a nested parallel block
- **THEN** it fails with the validator's message and starts nothing
