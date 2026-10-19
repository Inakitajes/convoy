# Proposal

## Why

Operators who use Codex could not run Convoy pipelines on it. OpenAI models could only run through OpenCode, which never uses the operator's ChatGPT plan or Codex's agent loop. Convoy already runs Claude Code behind the common harness contract. Codex exposes a programmatic surface, `codex app-server`, that fits that contract closely:

- every command, file edit and MCP call arrives as an approval request the client answers;
- per-thread config can keep the operator's MCP servers out and add Convoy's own host;
- threads can be resumed, steered and interrupted.

The details are in `evidence/app-server-spike.md`.

## What Changes

- **Runner.** Register a `codex` runner on the descriptors from `generalize-runner-routes`. It executes `openai/*` models and maps `#variant` to reasoning effort, both validated against the account's `model/list` at preflight.
- **Execution.** Run each attempt on an owned `codex app-server` child over stdio. The operator's hooks, apps, browser and computer use are disabled, the operator's MCP servers are disabled per thread, and Convoy's MCP host is declared per thread.
- **Enforcement.** Every command, file change and MCP call reaches Convoy's policy and then the run's operator gate, one action at a time. Shell inspection (`cat`, `rg`, `git diff`…) is judged as the reads it performs, because Codex reads only through its shell. Declined actions are explained into the running turn. Codex's sandbox is defense in depth.
- **Services.** Reports, scores, commit descriptions and advisors go through `convoy mcp --bridge-file`. The first-write checkpoint holds the first file change and steers the advice in. The loop guard nudges and stops the turn.
- **Authentication.** The operator's ChatGPT login (subscription) or an explicit API-key reference, logged in to a private per-use Codex home. `account/read` checks the effective account before preflight and before each attempt. Billing-policy rules are the same as Claude's.
- **Plans on Codex alone.** Helper inference (judge, branch name, commit text, advisor consultations), human-gate iterations and `[o]` (`codex resume`) all run on Codex, so a Codex-only plan never needs OpenCode.

## Capabilities

### New Capabilities

- `codex-runner`: Codex as a pipeline runner, helper route and advisor, under Convoy's policy, authentication and provenance.

### Modified Capabilities

<!-- None: runner-integration and runner-routing requirements apply unchanged; Codex is a new registered implementation of them. -->

## Impact

- New `src/runners/codex/**` (app-server client, protocol subset, adapter, attempt, auth, inspection, inference, preflight) and `src/codex-cli.ts`.
- Registration in `src/runners/compose.ts`, `declarations.ts` (`codexDeclaration`), `descriptors.ts`, `helper-inference.ts`, the session openers (`runner.ts`, `tui.ts`), human gates (`human.ts`) and preflight.
- `convoy mcp --bridge-file`, `policy.ts` (`unwrapShellScript`, `commandHardDenied`, `commandWords`).
- Docs: `runners.md`, `models.md`, `configuration.md`, `getting-started.md`, `development.md`, README.
- Depends on `generalize-runner-routes`.
