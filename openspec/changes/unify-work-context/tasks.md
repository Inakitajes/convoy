Baseline: PR #104 (`a20debe`, implemented `stable-feature-lifecycle`). Tasks below extend existing Features; they do not recreate its registry, resolver, assessment, run records, or identity-based close. All checkboxes describe remaining integration work, not already implemented lifecycle work.

## 1. Reconcile the baseline and route feature destinations

- [x] 1.1 Verify stable-feature-lifecycle is synchronized before this change is applied, then add a plain work-context projection over its existing resolver/assessment; verify explicit association, arbitrary branch names, missing context, and full multi-contract sets without a second resolver.
- [x] 1.2 Route remaining change-shaped Apply, Iterate, and Continue handoffs through feature identity and source references, preserving identity-based close without global cwd mutation; verify a temporary main checkout can target a spec that exists only in another worktree.
- [x] 1.3 Resolve the checkout before loading launcher configuration, pipeline choices, history, specs, relative attachments, and dirty state; verify differing main/worktree configuration and unrelated dirty-main fixtures select the worktree behavior.
- [x] 1.4 Revalidate destination identity before accepting effects and preserve selection on cancelled launch/return; verify deleting or changing the destination after Review does not execute elsewhere and cancellation starts no run.

## 2. Verify conversation integration feasibility

- [x] 2.1 Exercise public OpenCode session creation, exact-ID opening, client detach, service restart, and history resumption in a disposable checkout; record commands, installed versions, and observed outcomes in a validation note without relying on internal session storage edits.
- [x] 2.2 Prototype foreground OpenTUI suspend/child/restore using the installed terminal APIs; record normal exit, startup failure, non-zero exit, interrupt, and resize outcomes in a real terminal. Do not promote the conversation path if the foreground contract fails.
- [x] 2.3 Verify project authoring-command discovery and invocation for the existing `opsx-propose` command through supported OpenCode interfaces; record a successful invocation and an absent-command result with no global installation side effect.

## 3. Extend feature-owned authoring associations

- [x] 3.1 Add versioned conversation associations under existing feature directories using lifecycle store/locking conventions; verify old FeatureRecord compatibility, concurrent conversation updates, corrupt/unsupported records, and that navigation writes do not change associationRevision.
- [ ] 3.2 Connect feature-owned conversation data to existing discovery and explicit adopt/bind/revise actions; verify arbitrary branch adoption remains explicit, browsing writes nothing, and no parallel workId or registry is created.
- [ ] 3.3 Propagate existing missing/ambiguous/unreadable/rebind outcomes to work navigation and conversation actions; verify no fallback to main or foreign sources and that binding retains feature/session history without bypassing active-execution blockers.
- [ ] 3.4 Remove remaining UI-only heuristic authority in favor of the shared lifecycle assessment and resolver; verify even a sole candidate requires explicit association, full contract sets survive focused reading, and unknown evidence never enables close.

## 4. Manage conversations and terminal return

- [x] 4.1 Add the minimal conversation adapter and OpenCode implementation with harness-qualified session references; verify exact-ID resume, unavailable-session reporting, multiple linked conversations, and separation from phase session history.
- [x] 4.2 Extract generic window/pane hosting from OpenCode invocation construction and implement the foreground terminal host; verify executable arguments/cwd, restoration in every exit path, and existing explicit external backends.
- [ ] 4.3 Implement conversation-service discovery and lifecycle independent of run servers using existing coordinator patterns; verify active client detachment keeps required service alive and a run dashboard closing does not invalidate authoring sessions.
- [ ] 4.4 Coordinate shared lifecycle execution observations and managed writer ownership between authoring and run launches by validated checkout identity; verify conflicts across two Convoy instances, explicit control transitions, stale-claim reconciliation, and independent worktree concurrency.
- [ ] 4.5 Wire Iterate and conversation selection to foreground open/resume with return to the originating work/spec; verify no pipeline starts during authoring and changed artifacts refresh on return.
- [ ] 4.6 Preserve explicit external opening with independent startup/liveness reporting; verify successful pane creation followed by failed harness startup never appears as a successfully running conversation.

## 5. Create work before proposing

- [ ] 5.1 Add New feature review using existing branch/path validation and worktree location conventions, with detected-base default and explicit derivation; verify cancellation makes no repository effects and creation needs no spec or naming-model call.
- [ ] 5.2 Extend lifecycle creation/intent machinery with a display name independent of contracts and pre-proposal creation with an empty contract set; inject failure after checkout creation and before session startup to verify retained content and no duplicate worktree on retry.
- [ ] 5.3 Add Propose/Revise using the verified project workflow in the selected checkout; verify authored artifacts land only there and an unavailable command disables that action while ordinary conversation remains usable.
- [ ] 5.4 Associate newly authored changes without coupling work identity to change/branch names; verify even one suggested contract requires explicit revise/association review, multiple contracts are preserved, and differing change IDs cause no automatic branch rename.
- [ ] 5.5 Select the featureId already registered and returned by spin in interactive adoption, without creating a second record; verify existing spin refusals, file movement, no-commit behavior, and standalone `/move` output remain compatible without claiming external history moved.

## 6. Reuse feature run links and present Features as Home

- [ ] 6.1 Propagate existing FeaturePlanLink and durable lifecycle run linkage through every new UI launch without adding parallel work fields; verify historical grouping survives checkout deletion/reuse and old runs still read/resume under existing checks.
- [ ] 6.2 Replace the Home destination-poster selector with the project work list and New feature entry while preserving auxiliary navigation; verify existing Features vocabulary, shared assessment summaries/blockers, empty-contract pre-proposal state, completed history, compact widths, and no automatic agent launch.
- [ ] 6.3 Add work detail actions with separate conversation/resume and pipeline labels, linked spec/run views, and existing close integration; verify each action resolves the same work and close still uses its guarded base destination.
- [ ] 6.4 Persist last valid work/conversation selection and restore it on navigation and restart; verify return from reader, dashboard, launcher cancellation, and foreground conversation, including unavailable remembered work.

## 7. Validate and document the integrated workflow

- [ ] 7.1 Run an end-to-end temporary-repository scenario from main: create work, propose in its worktree, leave/reopen the exact conversation, launch a pipeline there, and return; record that no manual `cd`, `/move`, nested Convoy, or extra worktree was required.
- [ ] 7.2 Exercise terminal return and active-detach behavior in a normal terminal and supported multiplexers, plus two-work concurrency; document actual outcomes and any unsupported path rather than marking untested behavior as passing.
- [ ] 7.3 Update README and usage guidance for work creation, adoption, exact-session resume, recovery, and external-window options; verify the baseline lifecycle deltas are synchronized before this change and reconcile descriptive Purpose text during normal spec synchronization and verify examples against the implemented commands.
- [ ] 7.4 Run focused regression tests, `bun run typecheck`, `bun test`, `bun run build`, and strict OpenSpec validation; verify existing headless launch, legacy metadata, multi-contract close, archived/integrated/cleanup distinctions, lifecycle action menus, and phase transcripts remain compatible.

- [ ] 7.5 Validate overlapping deltas against both the current canonical specs and the effective baseline after stable-feature-lifecycle synchronization; verify no upstream scenario or ownership/evidence guarantee is removed and document the required synchronization order.
