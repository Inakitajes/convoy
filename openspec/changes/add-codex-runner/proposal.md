# Proposal

## Why

Operators who use Codex cannot run Convoy pipelines on it. OpenAI models can only run through OpenCode, and that never uses the operator's ChatGPT plan or Codex's agent loop. Convoy already runs Claude Code behind the common harness contract. Codex exposes a programmatic surface, `codex app-server`, that fits that contract closely: every command and file edit arrives as an approval request the client answers, MCP tools can be injected per invocation, and threads can be resumed, read and steered (`evidence/app-server-spike.md`).

## What Changes

- Register a `codex` runner on the registry from `generalize-runner-routes`. It executes `openai/*` models, maps `#variant` to reasoning effort, and validates both against `model/list`.
- Execute each attempt through an owned `codex app-server` child over stdio, with `--disable hooks`, Convoy's MCP host declared per invocation, and the thread bound to the attempt.
- Enforce Convoy's policy through app-server approval requests. Commands, file changes and MCP calls all reach Convoy's policy and then the run's operator gate. Convoy never answers with a session-wide or persistent amendment. The Codex sandbox is used as defense in depth: `read-only` for read-only and verify modes, `workspace-write` for writes.
- Support reports, scores, commit descriptions and advisors through `convoy mcp`, as Claude does. The first-write checkpoint holds the first `fileChange` approval.
- Authenticate with the operator's ChatGPT login (subscription) or an explicit API-key reference, check effective auth with `account/read` before each attempt, and apply the same billing-policy rules as Claude.
- Codex capabilities: read-only, write, verify, fan-out, parallel, approvals, structured deliverables, advisor bridge, live observation (journal), post-exit resume, session history, usage reporting, and the loop guard (through `turn/steer` and `turn/interrupt`). Native live attach stays unavailable until it is verified.
- Helper inference (judge, branch name, commit text, advisor consultations) and authoring conversations on Codex, so a Codex-only plan never needs OpenCode.

## Capabilities

### New Capabilities

- `codex-runner`: Codex as a pipeline runner, helper route and advisor, under Convoy's policy, authentication and provenance.

### Modified Capabilities

<!-- None: runner-integration and runner-routing requirements apply unchanged; Codex is a new registered implementation of them. -->

## Impact

- New `src/runners/codex/**`: app-server client, attempt adapter, approval translation, auth, model support, inference, conversations, and the descriptor.
- `src/runners/compose.ts` (registration), `src/runners/declarations.ts` (`codexDeclaration`), `convoy mcp` (thread-bound submission for Codex), and generated app-server types pinned to the supported Codex version.
- Docs: `runners.md`, `models.md`, `getting-started.md`, `development.md`.
- No pipeline syntax change beyond `runner: codex`. Depends on `generalize-runner-routes`.
