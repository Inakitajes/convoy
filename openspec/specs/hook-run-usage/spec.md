# hook-run-usage Specification

## Purpose
Give post-hooks the run's aggregated usage — what it cost, what it consumed and how long it worked — straight from the run's own metadata, so a project can report or gate on spend in a hook without parsing run files or re-deriving totals that Convoy already knows.

## Requirements

### Requirement: Post-hooks receive the run's aggregated usage

When Convoy runs post-hooks, on success and on failure alike, it SHALL export the run's aggregated usage in the hook environment, summed over every phase recorded in the run's metadata (pipeline steps, goal-fragment invocations and hook rows). `CONVOY_RUN_COST` SHALL be the total cost in USD — executor cost plus advisor cost, the same figure `convoy runs` reports as `cost`. `CONVOY_RUN_TOKENS_INPUT`, `CONVOY_RUN_TOKENS_OUTPUT`, `CONVOY_RUN_TOKENS_REASONING`, `CONVOY_RUN_TOKENS_CACHE_READ`, `CONVOY_RUN_TOKENS_CACHE_WRITE` and `CONVOY_RUN_TOKENS_TOTAL` SHALL be the summed token counts, where `TOTAL` follows the same definition as the phase totals the dashboard shows. `CONVOY_RUN_DURATION_MS` SHALL be the sum of the recorded phases' durations — the time the pipeline spent working, not the wall clock since the run was created. The aggregate SHALL come from the metadata the runner holds in memory, never from re-reading run files.

#### Scenario: A successful two-phase run

- **WHEN** two phases recorded usage of `0.5 USD / 1000 input / 200 output` and `0.25 USD / 400 input / 100 output`, with durations of 60000 ms and 30000 ms, and the run succeeds
- **THEN** the success post-hooks see `CONVOY_RUN_COST=0.7500`, `CONVOY_RUN_TOKENS_INPUT=1400`, `CONVOY_RUN_TOKENS_OUTPUT=300` and `CONVOY_RUN_DURATION_MS=90000`

#### Scenario: A run that fails in its second phase

- **WHEN** the first phase recorded usage, the second phase fails after recording some usage, and the failure post-hooks run
- **THEN** they see the cost, tokens and duration accumulated up to and including the failed phase, and `CONVOY_RUN_STATUS=failure` as before

#### Scenario: A goal cycle

- **WHEN** a goal cycle ran two measure rounds and one improve round before settling
- **THEN** the post-hooks, which run once after the whole cycle, see totals that include every fragment invocation of every round

### Requirement: Usage variables are omitted when nothing was recorded

Convoy SHALL NOT invent a zero: `CONVOY_RUN_COST` SHALL be exported only when at least one recorded phase carries an executor or advisor cost, the token variables SHALL be exported together only when at least one recorded phase carries executor usage, and `CONVOY_RUN_DURATION_MS` SHALL be exported only when at least one recorded phase carries a duration. When none is available no usage variable SHALL be set, mirroring how `CONVOY_RUN_SCORE` is absent on an unscored pipeline.

#### Scenario: A run that fails before any session reported usage

- **WHEN** a pre-hook fails after running for a while, so the failure post-hooks run with phases that have durations but no cost
- **THEN** `CONVOY_RUN_DURATION_MS` is set and `CONVOY_RUN_COST` and every `CONVOY_RUN_TOKENS_*` variable are unset

#### Scenario: A run whose only recorded spend is the advisor's

- **WHEN** a phase recorded an advisor cost of `0.20 USD` but its executor never reported usage before the run failed
- **THEN** the failure post-hooks see `CONVOY_RUN_COST=0.2000` and `CONVOY_RUN_ADVISOR_COST=0.2000`, and every `CONVOY_RUN_TOKENS_*` variable is unset

#### Scenario: A run that fails before any phase started

- **WHEN** the run fails before any phase recorded a start
- **THEN** no `CONVOY_RUN_COST`, `CONVOY_RUN_TOKENS_*` or `CONVOY_RUN_DURATION_MS` variable is set

### Requirement: Advisor spend is reported on its own

When any recorded phase carries advisor usage with a cost above zero, Convoy SHALL export `CONVOY_RUN_ADVISOR_COST` with the summed advisor cost, so a hook can tell the executor's share from the advisor's. `CONVOY_RUN_COST` SHALL already include that amount. When no advisor spend was recorded the variable SHALL be absent.

#### Scenario: A run with an advisor

- **WHEN** one phase recorded an executor cost of `1.00 USD` and an advisor cost of `0.20 USD`
- **THEN** the post-hooks see `CONVOY_RUN_COST=1.2000` and `CONVOY_RUN_ADVISOR_COST=0.2000`

#### Scenario: A run without an advisor

- **WHEN** no phase recorded advisor usage
- **THEN** `CONVOY_RUN_ADVISOR_COST` is unset and `CONVOY_RUN_COST` is the executor cost alone

### Requirement: Values use a fixed, documented format

Cost variables SHALL be decimal USD with exactly four fractional digits and no currency sign; token and duration variables SHALL be non-negative integers with no separators. The README SHALL document each variable, its format, and that the duration is a sum of phase durations.

#### Scenario: Formatting a fractional cost and a large token count

- **WHEN** the aggregated cost is `3.2` USD and the summed input tokens are `1234567`
- **THEN** the hook sees `CONVOY_RUN_COST=3.2000` and `CONVOY_RUN_TOKENS_INPUT=1234567`

### Requirement: Pre-hooks and existing hook variables are unchanged

Pre-hooks SHALL NOT receive any usage variable — nothing has been recorded when they run — and every variable post-hooks received before this change SHALL keep its name, presence rule and value.

#### Scenario: A pre-hook inspects its environment

- **WHEN** a pre-hook runs
- **THEN** `CONVOY_RUN_COST`, `CONVOY_RUN_ADVISOR_COST`, every `CONVOY_RUN_TOKENS_*` variable and `CONVOY_RUN_DURATION_MS` are unset

#### Scenario: An existing post-hook keeps working

- **WHEN** a post-hook written against `CONVOY_RUN_STATUS`, `CONVOY_RUN_SCORE` and `CONVOY_GOAL_*` runs after this change
- **THEN** it sees those variables exactly as before, with the usage variables added alongside
