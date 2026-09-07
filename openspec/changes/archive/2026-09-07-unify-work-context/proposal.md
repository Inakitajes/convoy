## Baseline

Reconciled against `a20debe` (PR #104, `stable-feature-lifecycle`). That change already supplies repository/feature IDs, explicit multi-contract associations, a shared resolver and assessment, spin registration, durable run links, and identity-based close. Its remaining unsynchronized deltas are a prerequisite baseline; synchronize them before this change so later archive cannot restore older rules. `docs/proposals/workspace-workflow.md` is historical analysis predating this integration.

## Why

Convoy can display specs from every worktree, but authoring sessions and some launch actions still use the checkout where Convoy started. Operators must manually coordinate specs, branches, worktrees, conversations, and terminal directories; Convoy should own that context throughout the development workflow.

## What Changes

- Extend the existing Feature identity with authoring conversations and the ability to start before proposing, retaining its reviewed multi-contract set and durable run/close links. No second work identity or registry is introduced.
- Resolve one explicit work context for reading, conversing, proposing, preparing and executing pipelines, and closing. Apply and Iterate use the selected worktree, including its configuration and attachments.
- Open and resume the exact linked OpenCode conversation in the current terminal by default, returning to the selected work when its client exits. Keep external windows as an explicit option.
- Create an isolated worktree before proposing a new change. Retain `spin` as an adoption path for proposals already created on the base checkout.
- Replace Home's destination-poster selector with a work list and work detail; retain access to pipelines, canonical specs, global run history, and configuration.
- Add session associations and navigation preferences alongside existing feature records. Reuse the shared lifecycle assessment for labels, blockers, and actions, extending it for pre-proposal features without duplicating state inference.
- Separate work context, conversation adapter, and terminal hosting. Keep OpenCode as the only initial conversation adapter and retain existing pipeline runners.

## Capabilities

### New Capabilities

- `work-context`: Work-first navigation over existing features, creation before proposal, explicit action context and focused-contract handling, preserving existing identity/assessment guarantees.
- `work-conversations`: Exact-session authoring continuity, foreground terminal return, explicit external presentation, and coordination with active writers.

### Modified Capabilities

- `home-launcher`: Work-first navigation, new-work entry, selected-work detail, and return/selection continuity replace destination posters.
- `control-board`: Reuse registered Features and shared assessment in Home; additionally expose pre-proposal features and unassociated worktrees with no runs.
- `specs-viewer`: Resolve reads and actions to the same work context and return to the selected subject after authoring or cancelled launches.
- `run-launcher`: Load all preparation resources from the verified feature checkout and preserve existing feature plan links, full contract sets, and revalidation.
- `feature-spin`: Preserve the headless `/move` handoff while integrating interactive adoption and selection into Convoy.

## Impact

Affected areas include `cli.ts`, `specs.ts`, `specs-browser.ts`, `control-board.ts`, `launch-tui.ts`, `home-tui.ts`, `tui-session.ts`, `opencode.ts`, `spin.ts`, run plans/metadata, and their tests. Extend the existing `src/feature-lifecycle/` services and feature-owned storage for conversations; reuse current plan/metadata feature links and durable run records. Existing CLI execution, historical runs, close receipts, and explicit publication remain supported.

The default Home layout and Iterate presentation intentionally change. The merged feature registry, arbitrary-branch support, explicit adoption/binding, shared lifecycle states, archive/integration distinction, and close receipts remain the authority. No migration to Pi, general harness plugin system, custom chat UI, or rewrite of pipeline execution is included. Phase transcript behavior remains unchanged.

This reconciled change supersedes the pre-merge analysis where they differ. Terminal restoration and public OpenCode session continuity require an implementation-time feasibility check before the conversation path ships.
