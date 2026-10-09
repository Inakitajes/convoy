## Why

Convoy currently uses a pinned V1 SDK against an unpinned local `opencode` executable, while OpenCode V2 changes the server/client and plugin contracts. We need a first migration phase that runs the existing Convoy workflows on V2 with behavior parity, before considering any new agent orchestration capabilities.

## What Changes

- Replace V1 client/API integration with a tested OpenCode V2 client/plugin/runtime combination, including startup authentication, sessions, prompt completion, events, history, permissions, usage and CLI continuation.
- Port `write_report`, `advisor` and `advisor_feedback` to the V2 plugin API while preserving their existing Convoy runtimes, validation, authentication and lifetimes.
- Preserve built-in and custom pipelines, YAML/config precedence, selected models, parallel review, goals, resume/retry, human gates, safety policies, reports, commits, authoring and CLI/TUI workflows.
- Adapt all existing OpenCode consumers, including preflight, catalog/routing, safety judge, naming/commit helpers, transcript backfill, terminal integrations, provider-limit display and OpenSpec authoring commands.
- Validate the local runtime/client compatibility before execution and produce an actionable error for an unsupported combination; do not install, update or replace the user's OpenCode automatically.
- **BREAKING**: the migrated integration targets OpenCode V2; retaining a parallel V1 runtime path is outside this change. Existing supported Convoy configuration and stored run records remain readable.
- Keep native subagent redesign, new step semantics, persistent advisors, pipeline topology changes and embedded OpenCode out of scope. Required V2 protocol adaptation is not a new workflow feature.

## Capabilities

### New Capabilities

- `opencode-v2-compatibility`: Existing Convoy behavior on a supported OpenCode V2 runtime, with explicit compatibility, execution, plugin, safety, observability and regression-validation requirements.

### Modified Capabilities

None. Existing lifecycle, goal, finalization, transcript, conversation and launcher requirements remain authoritative and unchanged; this capability specifies how the V2 integration preserves them.

## Impact

- Dependencies: replace legacy `@opencode-ai/sdk` with compatible, explicitly versioned `@opencode/client` and `@opencode/plugin` packages and update the lockfile during implementation.
- Modules: `opencode.ts`, `managed-server.ts`, `runner.ts`, events/progress/usage/permissions, agents/model routing/preflight, advisor/report bridges and runtimes, helper clients, conversations/terminal-host/attach and limits.
- Tests: preserve domain assertions and replace V1-shaped mocks with V2 contract fixtures plus isolated runtime/plugin validation.
- Documentation: runtime prerequisites and compatibility, authentication/continuation guidance and any unavoidable V2 operational differences; no new Convoy command or configuration DSL.
- Delivery: planning artifacts only now. Implementation and runtime acceptance must not silently drop an existing feature to accommodate an unresolved V2 contract.
