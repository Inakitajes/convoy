# Tasks

Depends on `generalize-runner-routes`.

## 1. Close the spike's open questions

- [ ] 1.1 Verify API-key mode with an owner-only per-run `CODEX_HOME` that leaves `~/.codex/auth.json` untouched; record the result in `evidence/`, and restrict API-key mode with a stated reason if it fails.
- [ ] 1.2 Verify how to exclude operator `mcp_servers` from a run while keeping Convoy's; verify an operator MCP tool is unreachable or declined.
- [ ] 1.3 Verify Seatbelt confinement of approved commands under `read-only` and `workspace-write`, and the behavior of the `zsh -lc` wrapper; record what policy must still cover.
- [ ] 1.4 Verify the decline-plus-`turn/steer` checkpoint delivers advice within the turn; verify `codex --remote` attach as a candidate for native live attach (record the verdict, do not enable it).
- [ ] 1.5 Fix the supported Codex version range and add `development.md` guidance for regenerating types.

## 2. Client and descriptor

- [ ] 2.1 Add generated app-server types at the pinned version and a stdio JSON-RPC client (requests, notifications, server requests, unknown-method errors, framing errors); verify with recorded fixtures.
- [ ] 2.2 Register the `codex` descriptor: probe, model support (`openai/*`, effort mapping, `model/list` validation), auth schema, capability declaration; verify the registry conformance and the dependency-direction tests.

## 3. Attempt execution

- [ ] 3.1 Implement the attempt adapter: owned child with `--disable hooks` and run-scoped `-c` overrides, `thread/start` per mode (D2), `turn/start`, event normalization into the journal, outcome on `turn/completed`; verify read-only, verify and write fixtures.
- [ ] 3.2 Implement approval translation (D3) on the shared policy: shell unwrapping, item-correlated file changes, MCP elicitation, decline-only for permissions and user input; verify the policy scenarios in `specs/codex-runner/spec.md`, including hard denials under `--yolo`.
- [ ] 3.3 Bind `convoy mcp` for Codex through a private bridge file and thread-bound submissions; verify deliverable validation, stale-thread rejection, and no secrets in argv or env.
- [ ] 3.4 Implement the advisor checkpoint (D4) and on-demand consultations; verify hold, advice delivery, failure release and the unreachable-checkpoint block.
- [ ] 3.5 Implement the loop guard through `turn/steer` and `turn/interrupt`, plus cancellation with the bounded grace; verify trip, cancel-during-startup and kill-after-grace.
- [ ] 3.6 Implement resume and history (`thread/resume`, `thread/read`) and provenance (requested and resolved model and effort, thread, auth); verify a resumed run and a late dashboard attach.

## 4. Auth, helpers and authoring

- [ ] 4.1 Implement subscription and API-key environments, the `account/read` effective-auth check per preflight and attempt, and the billing-policy rules; verify the auth scenarios and ambient-key removal.
- [ ] 4.2 Implement helper inference (judge, branch name, commit text, advisor consultation) on ephemeral, all-declining threads; verify a Codex-only plan with no OpenCode or Claude installed.
- [ ] 4.3 Implement authoring conversations and linked-session reopen with `codex resume`; verify the writer claim around the session.

## 5. Docs and release gate

- [ ] 5.1 Document Codex in `runners.md` (modes, enforcement, auth, billing, capability matrix, limits), `models.md` and `getting-started.md`; verify the examples parse.
- [ ] 5.2 Run an opt-in live smoke test on a disposable repo (read-only review, writable fix with an advisor, scored goal iteration), with explicit consent for token use; record it in `evidence/acceptance.md`.
