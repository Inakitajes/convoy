# Tasks

Depends on `generalize-runner-routes`.

## 1. Close the spike's open questions

- [x] 1.1 Exercise API-key mode with an owner-only per-use `CODEX_HOME`, verified with a scripted login. Recorded in `evidence/acceptance.md` that a live key was not exercised.
- [x] 1.2 Verify how to keep operator `mcp_servers` out of a run while declaring Convoy's: `mcp_servers={}` deep-merges, and per-server `enabled=false` in `thread/start` config works. Recorded in `evidence/acceptance.md`.
- [x] 1.3 Record what the read-only sandbox does and does not guarantee (spike finding 3), and cover the `zsh -lc` wrapper in policy (`unwrapShellScript`).
- [x] 1.4 Verify the decline-plus-`turn/steer` checkpoint delivers advice within the turn (live run, `evidence/acceptance.md`). Native attach with `codex --remote` is left unavailable.
- [x] 1.5 Set the minimum Codex version (0.160) and document regenerating the protocol reference in `development.md`.

## 2. Client and descriptor

- [x] 2.1 Add the protocol subset and the stdio JSON-RPC client (requests, notifications, server requests, unknown-method errors, exit handling); verify with a scripted server (`test/helpers/fake-codex.ts`).
- [x] 2.2 Register the `codex` descriptor, declaration and composition; verify the registry, capabilities and conformance tests.

## 3. Attempt execution

- [x] 3.1 Implement the attempt adapter (owned child, thread per mode, turn, event normalization, outcome, raw log); verify with scripted turns (`test/runner-codex-adapter.test.ts`).
- [x] 3.2 Implement approval translation on the shared policy: shell unwrapping, inspection as reads, item-correlated file changes, MCP elicitation, declines for anything else; verify the policy scenarios, including hard denials under auto-approve.
- [x] 3.3 Serve Convoy's tools through `convoy mcp --bridge-file`; verify the owner-only file, its discard, and that no token reaches argv or env (`test/runner-codex-services.test.ts`).
- [x] 3.4 Implement the first-write checkpoint and on-demand consultations; verify hold, advice delivery, failure release and the unreachable-checkpoint block.
- [x] 3.5 Implement the loop guard with `turn/steer` and `turn/interrupt`, and cancellation; verify nudge, stop and cancel.
- [x] 3.6 Implement resume (`thread/resume`) and provenance; verify that a continued session resumes its thread and that Codex records validate.
- [x] 3.7 Explain declined actions into the turn; verify the steered reason.

## 4. Auth, helpers and gates

- [x] 4.1 Implement subscription and API-key environments, the `account/read` check at preflight and per attempt, model and effort preflight, and the billing rules; verify each auth scenario.
- [x] 4.2 Implement helper inference on ephemeral read-only threads, with reads limited to the checkout; verify the judge and helper paths and that a Codex-only plan needs no OpenCode.
- [x] 4.3 Iterate human gates on Codex, reopen a step with `codex resume`, and refuse Codex authoring with its reason.

## 5. Docs and release gate

- [x] 5.1 Document Codex in `runners.md`, `models.md`, `configuration.md`, `getting-started.md`, `development.md` and README.
- [x] 5.2 Run a consented live run on a disposable repo (an advised implementation, then a read-only audit) and record it in `evidence/acceptance.md`.

## 6. Review fixes

- [x] 6.1 Judge shell inspection fail-closed (per-program option values, expansions, globs, changed environments) and limit git to reads inside the checkout; verify every bypass spelling the review found as a regression test.
- [x] 6.2 Start no thread when the operator's MCP servers cannot be read, or one is named `convoy`; verify for attempts and helpers.
- [x] 6.3 Gate preflight on the minimum Codex release read from `initialize`; verify an old and a current release.
- [x] 6.4 Refuse to reopen a thread Codex no longer holds (API-key threads); verify against a scripted Codex home.
- [x] 6.5 Run the shared runner conformance suite against the Codex adapter.
- [x] 6.6 Refuse an unreadable Codex release, and check the release in attempts and helpers too; verify a drifted user agent and an old release in each.
- [x] 6.7 Keep undelivered first-write advice and decline writes until it reaches the turn; verify a failing then recovering steer.
- [x] 6.8 Reopen a phase's Codex session from the gate under the phase's auth; treat inspections that read a list of paths from a file as execution.
