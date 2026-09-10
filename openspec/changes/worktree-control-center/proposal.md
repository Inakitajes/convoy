## Why

Convoy currently reconciles two competing models: inferred OpenSpec/worktree state and a persistent feature registry with contract associations and landing receipts. External archive, branch rename, or worktree removal exposes the mismatch; replacing that lifecycle with a worktree control center makes ordinary Git and OpenSpec operations predictable without another domain to repair.

## What Changes

- Make **Worktrees** the primary Home and control-center vocabulary. A worktree is a Git checkout, not a new persisted entity; do not introduce “Spaces”, work IDs, ownership manifests, or completion tombstones.
- Enumerate every worktree registered in the current Git repository, including externally created, main, detached, locked, inaccessible, and spec-less checkouts. Show independent Git, PR, local OpenSpec, execution, and managed-writer facts rather than a global lifecycle stage.
- Read changes, tasks, archives, and canonical specs only inside the selected checkout. Identical change IDs in different worktrees remain independent sources; inherited files are present, not owned. Archive or run only explicitly selected changes.
- Create worktrees through “What are we building today?”: propose a conventional branch and conventional location, review/edit the base and destination, then create without commits, PRs, or feature registration.
- Expose independent fetch, sync-with-base, push, semantic PR composition/creation, archive-change, pipeline, conversation, squash-to-base, worktree removal, and branch deletion actions. Close becomes an optional composition of those same operations with explicit archive selection and optional cleanup.
- **BREAKING** Remove persistent feature identity, contract sets, association revisions, adoption/rebinding, global lifecycle assessment, and durable landing receipts. Existing registry files become inert, not migrated to another registry. Preserve actual run recovery/history and minimal unresolved-operation recovery.
- **BREAKING** Replace inferred global change ownership and feature-gated launch/publication with explicit worktree targets. Retire `convoy feature` operations with actionable diagnostics; retain only unambiguous compatibility routes for `control`, `close`, and standalone `spin`.
- **BREAKING** Publication is no longer only a run-end action: standalone push works without GitHub or a run, and PR drafts describe the reviewed current branch range with optional model-backed semantic composition and an honest deterministic fallback.

## Capabilities

### New Capabilities

- `worktree-operations`: Independent, guarded Git/OpenSpec/publication operations; explicit scope, truthful evidence, and temporary crash recovery without durable lifecycle authority.

### Modified Capabilities

- `control-board`: Worktree inventory and independent observations replace feature-stage aggregation and cross-checkout ownership.
- `home-launcher`: Worktrees-first navigation, New worktree, and contextual action menus.
- `work-context`: Git-derived explicit targets, reviewed creation, local change selection, and removal of feature associations.
- `feature-lifecycle`: Retire the entire persistent feature lifecycle and define safe legacy-state retirement.
- `feature-spin`: Keep explicit legacy proposal transfer without feature registration or adoption.
- `feature-close`: Compose worktree operations; replace receipt-based lifecycle closure with temporary recovery and independent cleanup.
- `specs-viewer`: Checkout-local active/archive/canonical browsing and selected-change actions, without ownership resolution.
- `run-launcher`: Explicit execution checkout and selected local changes, with existing dirty-tree consent preserved.
- `run-finalization`: Preserve run compaction/provenance while sharing independent worktree publication operations and removing feature linkage.
- `work-conversations`: Resume exact sessions for validated checkout targets without feature identity; preserve writer coordination.
- `worktree-location`: Preserve naming/allocation conventions while resolving existing targets from Git rather than associations.
- `run-titles`: Resolve proposal titles from explicitly selected checkout-local change inputs, not branch-to-change ownership guesses.
- `step-commit-messages`: Preserve run-specific recovery and semantic commit compatibility without durable feature-close evidence.

## Impact

The main implementation surfaces are `src/feature-lifecycle/`, `control-board.ts`, `specs.ts`, `specs-browser.ts`, `home-tui.ts`, `cli.ts`, `worktree.ts`, `git.ts`, `spin.ts`, `feature-close.ts`, `feature-close-command.ts`, `publish.ts`, launch/run metadata, and conversation services. Generic writer coordination and storage must be extracted before retiring feature modules. Git, OpenSpec, OpenCode, and optional GitHub CLI integrations remain; no new provider, daemon, database, or worktree registry is required.

Existing worktrees, branches, specs, sessions, and run recovery refs must not be deleted or rewritten by migration. Successful operation journals are removed; unresolved operations remain recoverable outside the checkout they may remove. Legacy feature data is ignored for discovery and authority, with explicit scoped cleanup only after unresolved legacy operations have been reconciled. This is planning only; implementation and main-spec synchronization are separate workflows.
