## Context

Baseline: commit `a20debe` (PR #104), including the implemented `stable-feature-lifecycle` change. See `proposal.md` for motivation. The earlier document in `docs/proposals/workspace-workflow.md` describes the pre-merge code and is not the current architectural baseline.

Already present: `FeatureRecord` with `featureId`, `repositoryId`, `displayName`, `associationRevision`, `contracts[]`, intended base, current context, run and close links; repository-scoped records under `convoy/features`; shared resolution/observation/assessment; explicit adopt/bind/revise/new-work operations; spin intent and registration; `FeaturePlanLink` in plans/metadata; durable lifecycle run and close evidence. Any Git-valid associated branch is supported and names do not authorize ownership.

Remaining integration gaps: `cli.ts:openSpecsBrowser` still routes Apply by change ID and Iterate through the launch directory; `launchRunTui` initially loads resources from that directory. The new identity-based close path and lifecycle rows coexist with legacy change-shaped routes. This change completes those UI handoffs, adds authoring session continuity, and exposes creation before proposal. It must not infer absence of lifecycle infrastructure from legacy helper functions still present in `control-board.ts`.

The merged lifecycle change is not fully synchronized into canonical specs: its feature-lifecycle capability still lives under `openspec/changes/stable-feature-lifecycle/specs/`. Overlapping deltas here retain that implemented contract. Synchronize the prerequisite before this change; do not archive this change against an older partial baseline.

## Goals / Non-Goals

**Goals:**
- Make an action's repository, checkout, change, and session explicit before resource loading or effects.
- Link authoring conversations to existing feature identities and use the shared lifecycle assessment everywhere, including new pre-proposal state.
- Use OpenCode's interactive client with a reliable return to Convoy, preserving its public session identity.
- Introduce only the seams exercised by context routing and conversation presentation.

**Non-Goals:**
- Reimplement OpenCode's chat UI, embed a terminal emulator, or migrate to Pi.
- Normalize provider APIs, permissions, tool events, or every pipeline runner into a universal harness interface.
- Automatically move or summarize arbitrary external sessions, manage the parent shell's cwd, or create PRs during work creation.
- Detect every unmanaged external writer, change close/finalization guarantees, or rewrite phase transcripts.

## Decisions

### D1. Resolve work before loading launch resources

Introduce a thin plain-data work-context projection over `feature-lifecycle/resolver.ts` and `assessment.ts`; reuse their selectors, status variants, association revisions, and blockers rather than implementing another resolver. Distinguish launch directory, existing repository UUID plus resolved Git common directory, execution checkout, Git worktree administrative identity, current branch, explicit base target/ref, and complete reviewed contract set and optional focused contract/source. Reader focus never revises the set; explicit selectors are cross-checked with the feature record. UI actions carry a work reference and optional change reference rather than unrelated path strings. The resolver returns either validated context or a structured unavailable/ambiguous/stale result.

Apply this first to existing board selections. Load merged configuration, pipeline choices, PRD history, spec bundles, relative attachments, and dirty status against the resolved execution checkout. Keep base detection and close landing destinations explicit. Do not call `process.chdir()`. Re-resolve immediately before effects; a changed destination invalidates Review instead of quietly updating the accepted plan.

Alternative considered: patch Apply and Iterate independently. That leaves launcher resource loading and later actions free to disagree; one small resolver provides a reusable correction without a runtime rewrite.

### D2. Extend existing features instead of creating work records

Work is the UX concept for the existing Feature domain, not a second entity. Keep `featureId`, `repositoryId`, `displayName`, `associationRevision`, `contracts[]`, intended base, context, and all current durable history. Keep Features terminology in the UI and accept arbitrary Git-valid branch names. Do not add `workId`, a `convoy/work` registry, or a parallel lifecycle state machine.

Add versioned authoring-session associations under the existing feature directory, keyed by that same identity, plus repository-local selection preferences. Use feature-store atomic writes, locks, path validation, and revision conventions. Conversation/navigation updates must not spuriously advance the execution association revision and invalidate accepted run plans; contract/context edits continue through the existing association operations. Old feature records and run links must load without eager migration. Preserve explicit unreadable/corrupt/unsupported outcomes.

Reuse existing discovery, adoption, binding, and ownership validation. Metadata-free candidates are suggestions only: even one branch-name match or sole change requires explicit association acceptance before mutation. Do not downgrade a missing associated source to a foreign same-slug copy. Keep historical identity after branch renames/moves and require verified binding, blocked during active execution or unreconciled mutation. A completed context reused for new work gets a fresh feature identity through the existing new-work semantics.

Extend the creation command path to accept a display name independently of contracts and allow a registered pre-proposal feature with `contracts: []`. The current record validator allows an empty array, but `featureNewWork` derives displayName from changes and its command path needs adaptation for this UX. Do not fabricate an OpenSpec change to satisfy it. Extend the shared assessment to identify an idle, verified zero-contract feature as awaiting proposal and expose only applicable actions; do not infer close readiness from empty or completed tasks.

Alternative considered: a separate work store layered above Features. It would duplicate exactly the identity, ownership, and persistence now implemented by PR #104 and require synchronization between two authorities.

### D3. New work is created before authoring

Add New feature with a short title/ID, editable validated branch, detected base for independent work, and reviewed destination using existing worktree conventions. An explicit derive action can select another work's validated tip as source. Opening this form does not call a naming model or mutate Git.

After acceptance, extend the existing lifecycle operation/intent machinery with a creation-intent record with operation ID and planned destination, create the worktree, then finalize its association before starting the agent. The intent is recovery evidence, not lifecycle status. If persistence or startup fails, preserve the worktree, show the partial result, and reconcile the operation on retry. Discover orphaned results even if final registration failed. Never remove potential authored content automatically.

Propose uses the authoring command available to the chosen harness in that checkout. The current project carries `.opencode/commands/opsx-propose.md`; the OpenCode adapter must validate its discovery and invocation through the supported command API before launch. If absent, expose Propose as unavailable with ordinary conversation still usable; do not install global commands or imitate successful workflow execution. On return, suggest eligible new contracts for explicit association review using the existing revise workflow, including when there is only one candidate. Preserve existing contracts unless the reviewed revision explicitly changes them; reader focus is not a contract-set edit. Keep branch naming independent of the resulting change ID.

For proposals already stranded on the base checkout, reuse spin's file movement and refusal rules. The interactive wrapper selects the featureId already returned by spin and offers its conversation; it must not register a duplicate feature. Standalone spin preserves `/move` output and its opt-in global command contract. This change does not improve spin by copying unknown external session history.

Alternative considered: automatically relocate every session after proposing on main. This starts work in the wrong place and depends on a harness-specific relocation feature. Creating the destination first removes that dependency from the normal route.

### D4. Separate conversation identity from terminal presentation

Add a minimal conversation adapter responsible for creating, validating, and opening an exact public session reference in a resolved work context. Its initial implementation is OpenCode. Durable references contain harness ID and session ID; transient connection handles remain within the adapter. Public session creation/get APIs are present in the installed SDK, but create/attach/restart continuity must be verified against the actual installed client/server before shipping this path.

Extract generic window/pane launching from `opencode.ts` into a terminal host. It accepts an executable/argument/environment description plus explicit cwd and presentation. Shell-based backends retain proper quoting, but the foreground child uses structured arguments. Herdr, Zellij, Ghostty, and Terminal.app are presentation backends, not harnesses.

Foreground hosting suspends OpenTUI, starts the interactive child with the terminal streams, awaits child exit, and restores input ownership, signal listeners, renderer, and current dimensions in `finally`. The installed renderer exposes suspend/resume; prove normal return, failure, interrupt, and resize in a real terminal. Do not render Convoy concurrently with the child. On return, refresh work detail and retain selection. External opening remains an explicit action and startup is confirmed independently of pane creation.

Keep `StepRunner` for automated phases. A conversation adapter does not imply support for advisor, model fanout, verification, or takeover. Add capability checks only for concrete differences needed by these actions, not a speculative plugin registry.

Alternative considered: build an embedded chat client on the OpenCode SDK. That increases UI scope and duplicates an existing interface. Alternative: keep external windows as default. That cannot provide the requested single-terminal return path.

### D5. Keep execution ownership separate from view lifetime

Authoring sessions must not use a run-owned server whose shutdown invalidates their conversation. Reuse the repository's coordinator/control patterns for a conversation service that manages OpenCode connections and session execution independently of a particular TUI attachment. Store transient service discovery separately from durable work records; verify liveness rather than trusting a saved PID or URL. On restart, reestablish the public session connection without guessing the most recent session.

Client exit means the view closed. Query execution state before releasing ownership or stopping required services. If execution remains active, keep the service alive and expose reattach or explicit stop. Use the existing run-control transition mechanisms where applicable; introduce only the missing authoring ownership integration. Shared lifecycle action eligibility is reused and extended with authoring execution observations; no local UI stage/boolean may override it. A managed writer claim is scoped to validated repository/worktree identity and checked by both pipeline launches and authoring launches, including separate Convoy instances. A stale or uncertain claim requires reconciliation, not unconditional takeover. Unknown external processes remain outside this guarantee.

This is a bounded lifecycle addition, not a new general scheduler. The feasibility checkpoint must demonstrate public session restart behavior and active-detach handling. Failure blocks the conversation delivery, while the independent destination correction can still ship; it does not authorize silently switching harnesses or declaring external-only presentation equivalent.

### D6. Preserve existing run associations and identity-based close

Reuse `FeaturePlanLink`, `resolveFeatureForLaunch`, `revalidateFeatureLink`, metadata feature fields, and durable lifecycle run records already introduced upstream. This change ensures every feature UI route actually supplies them before resource loading. Preserve the full contract set, repository ID, association revision, branch/worktree, and intended base; a focused contract is UI context, not permission to reduce the run/close scope.

Continue using identity-based close, receipt/archive verification, stale-evidence handling, publication assessment, and the rule that all branch work belongs to the reviewed feature. Archived contracts remain readable but another implementation requires the existing explicit new-active-work decision. A local landing is not a hosted PR merge; cleanup remains a separate fact. Do not rewrite old runs or create another history store.

Alternative considered: add work-specific identity fields to metadata. Existing feature links already express the required provenance; propagating them fixes the gap with less schema surface.

### D7. Reorganize Home after work actions function

Home becomes a project Features list plus New feature, with detail exposing Conversation/Resume, Propose/Revise, Execute pipeline, Specs/Runs, and Close. Retain auxiliary project/global views, completed feature history, the lifecycle action menu, and plain CLI behavior. Home, board, menus, and shortcut handlers all consume the same assessment; retain existing evidence-based summary vocabulary and extend only the pre-proposal case. Preserve selection on nested returns and between invocations without automatically launching an agent. Missing remembered work is a visible unavailable association, not a silently substituted target.

Retire destination poster, diamond selector, centered descriptions, and no-hints layout obligations through the Home deltas. Reuse existing theme/header primitives and reading/dashboard scenes. Canonical specs remain reference documents rather than pretending to be executable work. A work detail distinguishes authoring conversations from phase transcripts; `session-transcripts` requirements do not change.

## Risks / Trade-offs

- Public session lifecycle or foreground restoration differs from assumptions → run the explicit terminal/API checkpoint before building the new default experience; do not use internal database edits as fallback.
- Persistent associations become stale → store references with Git identity evidence, derive status live, and require explicit repair for moved/reused destinations.
- Creation fails between filesystem effects → durable intent plus reconciliation; preserve content and reuse validated results.
- Two UI instances lose updates or start writers → revision-aware record updates and a shared execution ownership check; uncertain state is visible.
- Scope expands toward multi-harness → keep only the context, conversation, and terminal seams; retain existing phase runners and provider integration.
- Home loses its poster presentation → intentionally prioritize actual work navigation while preserving theme, identity, and auxiliary access.
- Partial upstream spec synchronization → synchronize stable-feature-lifecycle first and then validate these overlapping deltas; do not run the earlier changes after this one and restore external-only Iterate or discard the new navigation contract.

## Migration Plan

Prerequisite: preserve PR #104 as the baseline and synchronize its implemented OpenSpec deltas before applying/synchronizing this change. This update does not archive or edit that separate change.

1. Ship destination resolution first: Apply/Iterate and launch preparation share the selected checkout. Add focused multi-worktree regressions.
2. Execute the public-session/terminal feasibility checkpoint. Extend existing feature-owned storage for session associations and add the adapter, foreground host, shared execution ownership, and exact-session resumption.
3. Add creation intent/recovery, New feature, external-work adoption, project Propose, and propagation of existing feature plan links.
4. Promote work navigation to Home and integrate existing readers, dashboards, and close. Update documentation and synchronize approved delta specs through the normal OpenSpec workflow.

During development, retain legacy standalone CLI/window entry points. If foreground integration cannot meet its contract, retain the completed destination fixes and do not promote the new conversation path to default. Rolling back code leaves additive local records and optional metadata untouched; do not delete records, sessions, or worktrees. Verify old metadata readers tolerate additional fields before rollout. No migration of provider credentials or historical transcripts is required.

The project-specific authoring command spelling and exact supported terminal behavior are implementation verification items with failure outcomes defined above, not grounds for expanding the product scope.

## Planning validation

This reconciliation passed `openspec validate unify-work-context --strict` against the current canonical specs and an isolated effective baseline with the implemented stable-feature-lifecycle deltas overlaid. All scenario names in overlapping predecessor requirements were retained. The check changed neither canonical specs nor the predecessor change. This is specification validation, not a test of the proposed runtime behavior.
