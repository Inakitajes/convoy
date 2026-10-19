# Codex runner acceptance (2026-10-18)

Live runs of the implemented runner (`codex-cli 0.163.0`, macOS, ChatGPT login, operator consent given in the session that built it), plus the protocol checks that closed the spike's open questions. Model calls ran on the operator's plan at low reasoning effort.

## Live pipeline runs

A disposable repository (`math.js` exporting `add`) with this project config:

```yaml
runners:
  codex:
    auth:
      billingPolicy: account-policy
defaults:
  runner: codex
pipelines:
  codex-e2e:
    steps:
      - agent: implementer
        model: openai/gpt-6.1-sol#low
        advisor: { runner: codex, model: openai/gpt-6.1-sol#low }
      - agent: bug-auditor
        model: openai/gpt-6.1-sol#low
```

Each was run as `convoy --pipeline codex-e2e --no-tui --no-confirm --no-worktree --no-human-step --yolo "Add a subtract(a, b) function to math.js…"`.

| Run | Result | What it showed |
|---|---|---|
| `20261018-195722-ngiy` | implementer added `subtract`; first-write advisor consulted on Codex; step committed and compacted. The auditor **could not read anything** and reported an incomplete audit. | No OpenCode server for the plan. The checkpoint works. A read-only Codex step reads only through its shell, which a read-only policy denied (it also told the agent "bash is unavailable"). This led to the inspection-as-reads decision (design D3). |
| `20261018-200054-cixu` | the auditor read the checkout. The implementer **gave up** after one chained command (`cat …; ls -la <run dir>`) was declined, because Codex told it "rejected by user". | `ls -la` was treated as a recursive read of a directory holding a protected one, and the agent never learned why its command was declined. This led to `ls`/`grep` counting as recursive only with `-R`, and to declined actions being explained into the turn (design D3). |
| `20261018-200242-0z33` | **complete**: implementer added `subtract`, the advisor (Codex) was consulted before the first write, the step committed, and the auditor read the PRD, reports, diff, commit and module and found nothing. Compacted to `feat(math): add subtract function`. | The full path on Codex: approvals, inspection reads, the advisor checkpoint through `turn/steer`, `write_report` through `convoy mcp --bridge-file`, the journal, usage, provenance and finalization. |

Final usage of the complete run (input/output/reasoning tokens): implementer 31,047 / 1,159; auditor 19,723 / 854 / 7. Cost is reported as unavailable, because Codex reports no price.

The commit writer in these runs used the operator's global `defaults.commitMessageModel` (an OpenCode model), so OpenCode started only for compaction. That is the documented rule: an explicit helper selection is never converted.

## Protocol checks

| Question | Result |
|---|---|
| Can a run keep the operator's MCP servers out? | `-c mcp_servers={}` does **not** clear them: overrides deep-merge. A per-server `mcp_servers.<name>.enabled=false` works, both as a `-c` override and in `thread/start`'s `config` (a probe server did not start when disabled and did start when enabled). The adapter reads the operator's servers with `config/read` and disables each per thread. |
| Is `codex_apps` (Codex's built-in apps server) a tool surface in runs? | It started in the spike. Runs pass `--disable apps`, and any MCP elicitation from a server other than `convoy` is declined. |
| Does `thread/start` accept per-thread config? | Yes: dotted keys and nested objects both apply. |

## Not exercised live

- **API-key mode.** The private-home flow (`codex login --with-api-key` into an owner-only `CODEX_HOME`, then `account/read` reporting `apiKey`) is covered by tests with a scripted login. No live key was used.
- **Interactive approvals and the smart judge on Codex.** These are covered by unit tests through the shared operator approval service. The live runs used `--yolo`.
- **Verify-mode steps and the goal loop on Codex.** They share the attempt path the live runs exercised. Their mode-specific policy is covered by tests.
