## Context

See proposal.md for motivation and scope. Current implementation has overlapping authorities: `control-board.ts` joins worktrees/changes/runs and derives stages, `specs.ts` replaces artifact sources across checkouts, and `feature-lifecycle/` persists associations then observes Git to reconcile them. `observe.ts` includes cross-checkout archive heuristics; `assessment.ts` can hide a verified landing behind Context missing. `runner.ts` also contains a launch-checkout fallback for absent execution-checkout artifacts. Removing only Home's feature labels would leave these conflicting paths intact.

Useful mechanisms already exist: worktree allocation/naming, Git primitives, OpenSpec readers, pipeline/runtime, conversation services, PR formatting, candidate construction, inline message review, writer coordination, and run compaction recovery. They are reusable ideas, not automatically safe extraction targets: publication currently tolerates some failed lookups as absence, archive structural checks cannot prove normative content, and close recovery ordering around base materialization needs fault testing.

This design applies across modules and changes persistence/compatibility, so design.md is required rather than conditionally omitted. The capability paths `feature-close` and `feature-spin` remain existing spec locations to avoid unrelated path renames; their new behavior does not preserve the feature domain.

## Goals / Non-Goals

**Goals:**
- Reduce authority to Git inventory, selected-checkout files, hosting observations, and live execution facts.
- Make independent actions share one set of target validation and operation-specific guards.
- Preserve operational safety without permanent feature state, receipt history, or an equivalent registry under another name.
- Delete obsolete paths after replacement consumers work; do not maintain two long-term models.

**Non-Goals:**
- No Spaces branding, worktree UUID registry, ownership manifests, completed-work history, or persistent PR-status database.
- No global deduplication of change IDs, automatic archive selection, or attempt to discover which checkout owns a copied change.
- No automatic conflict-resolution agent, background fetch, force-push, hosted PR merge/closure, or remote branch deletion.
- No replacement of OpenSpec's workflow, pipeline engine, run compaction, or harness session storage.
- No proof of historical local squash integration after temporary operation evidence has been released.

## Decisions

### D1. A worktree is an inventory entry, not a domain record

Enumerate the repository through one `git worktree list --porcelain -z` parser. Resolve the common directory and each available checkout's worktree Git administrative directory using Git, not branch-derived path templates. Include main, external, detached, locked, inaccessible/prunable, and spec-less entries. A bare entry is repository metadata, not an executable checkout.

An in-memory target contains the canonical common directory, observed worktree administrative locator, checkout path, current branch/detached state, and HEAD. At action time it is re-observed, with OIDs pinned where the operation requires them. This is observed Git identity, not a minted ID. Same-name paths and branches are insufficient to establish an old run or session's current destination; unverifiable replacement requires explicit fresh selection. Arbitrary external remove/recreate races cannot be completely prevented by a Convoy lock and must not be claimed as such.

Folder basename is the visible worktree name, qualified by path/branch when ambiguous. Human run/PR titles continue to contain normal whitespace. A moved checkout discovered through Git needs refresh, not bind. Removed inventory entries disappear; a stale Git registration is shown as inaccessible with repair/prune guidance, never a missing feature.

**Rejected:** retaining feature UUIDs as worktree UUIDs, naming rules as identity, or a `.convoy/worktree.json` manifest. Each would reintroduce lifecycle reconciliation.

### D2. Observe independent facts; do not synthesize a lifecycle

Use small typed observations with known/unavailable states, source, and collection time. Collect local inventory first, local detail lazily or with bounded concurrency, and optional PR queries asynchronously. Do not require a giant global snapshot to render a usable list. A failed probe is not a negative fact. Observe the managed-writer claim (kind, owner, liveness) as its own fact, independent of execution activity: a stale claim is not a live writer, an unreadable or newer-schema record is unknown rather than free, and the detail's disabled state is a projection of the same guard the handlers revalidate before any effect.

Git comparisons use explicit operands:
- `base...HEAD` gives base-only/source-only commit counts; base contained in HEAD means up to date with that selected revision, not merely related histories.
- `upstream...HEAD` gives locally known remote-only/local-only counts; no upstream is a distinct condition, not zero divergence.
- `HEAD` ancestor of base means current tip is reachable in that base's history. Equal trees means no content difference. Neither is a promise that code was not later reverted.
- Hosting reports PR state independently; merged-head coverage is unknown unless exact evidence is available. A merged PR for an old head/reused name never makes current work completed.

PR cache is in memory, keyed by hosting repository/head repository/branch/base; initial TTL 30 seconds, bounded requests, timeout, manual refresh, and explicit observation time. It is advisory and discarded on session end. Mutation always revalidates relevant facts. Fetch is a visible operation, never a list-render side effect. Missing `gh` disables hosting operations, not local use or push.

**Rejected:** another `status = completed|ready|missing` hierarchy; persistent observation caches treated as truth; patch-equivalence lifecycle inference. Commit counts are facts, not feature progress.

### D3. Files are local inputs, never ownership

Nested change keys are `(observed checkout, local source path)`; no global `changeId -> worktree` winner. Active changes, archives, canonical specs, task counts, and titles all come from the selected checkout. List malformed/husk entries as incomplete artifacts without fabricated task counts. Archive uses the real OpenSpec result, including date-prefixed directory names; no fixed undated archive lookup.

Show active changes expanded and archive/canonical browsing on demand to avoid repeating the entire repository archive in every worktree row. Say “present in this checkout”, not “belongs to this worktree”. Main is selectable like other checkouts with operation guards; it is not forced through spin/adoption.

Selecting one change pins just that local input; an explicitly ordered multi-selection is supported for runs and archive batches. Selection exists in the reviewed operation/run inputs, never in a live contract registry. Pipelines can run with explicit manual/no-change input. A singleton can be suggested but not silently accepted; headless input must select changes or the explicit no-change mode. Archive selection and whole-branch integration scope are separate in the review.

External archive/deletion updates the next listing with no repair workflow. During an already-reviewed operation, disappearance is stale input requiring re-review or recovery, not success. Remove cross-tree artifact fallback in the runner as well as viewer overlays and branch-to-change composition heuristics.

**Rejected:** automatic attachment of all local changes. Sync/fork can bring unrelated changes into a checkout; presence cannot prove ownership.

### D4. One operation layer, multiple entry points

Use simple operation modules with `inspect/review/execute/reconcile` responsibilities as needed, not a generalized workflow engine or event store. Each action owns its prerequisites. UI enabled states are advisory projections of those guards; disabled actions remain inspectable. Keyboard handlers, headless requests, dashboard publishing, and close invoke the same guards again before effects.

Proposed public command surface (exact help/flags are part of implementation tests):

```text
convoy worktrees                         # inventory / control center
convoy worktrees new                     # describe, suggest, review, create
convoy worktrees fetch --worktree <path> --remote <name>
convoy worktrees sync --worktree <path> --base <ref>
convoy worktrees push --worktree <path> [explicit remote/ref]
convoy worktrees pr --worktree <path> [explicit repo/head/base]
convoy worktrees archive --worktree <path> --change <id> [--change <id> ...]
convoy worktrees run --worktree <path> [--change <id> ... | manual input]
convoy worktrees squash --worktree <path> --base <local-branch>
convoy worktrees close --worktree <path> --base <local-branch> [selected changes]
convoy worktrees remove --worktree <path>
convoy worktrees delete-branch --branch <name>
convoy worktrees recover --operation <id>
```

Operation IDs identify unresolved attempts only. Destructive headless commands require explicit targets and the same safety checks/consent semantics, never hidden fallback to the launch checkout. `convoy control` opens this same board. `convoy specs` is its artifact-focused reader entry: without a selected checkout it shows the same worktree-rooted inventory; with a checkout it opens that checkout's local artifact sections. It does not maintain a competing board model. `convoy close` delegates to the same composite. Existing branch selectors are accepted only when they resolve uniquely to the intended live checkout. Feature-ID flags and `convoy feature` stop with migration guidance rather than being interpreted as prompts.

### D5. Base and remote are operation inputs, not stored domain attributes

Use the selected PR base when applicable, otherwise the existing repository base-detection behavior as a suggestion. Show the resolved reference and tip before mutation; ambiguous/unavailable bases require a choice. Do not silently assume `main`, confuse upstream with integration base, or store a new per-worktree intended-base record. Session memory can prefill prior choices but cannot authorize an effect. Custom bases such as `develop` or release branches are first-class.

Sync merges the pinned chosen base into a clean attached source; it does not fetch, stash, rebase, or touch the base checkout. Conflicts stop in ordinary Git conflict state with abort/resume guidance. A remote reference can be selected for sync; local squash requires an actual selected local base branch and a clean base checkout.

Push is independent of `gh`, runs, and OpenSpec. It validates the reviewed source/destination, publishes the pinned committed OID with a non-force refspec, and reports it explicitly. Readable uncommitted files need disclosure, not automatic commit or a blanket push prohibition. A changed source before execution triggers renewed review; subsequent local commits cannot silently join the pinned push. Remote ref rejection has no force fallback.

### D6. PR text describes the current complete range

Extract discovery, push, composition, and creation from `publish.ts` rather than reusing the old run/feature wrapper. Scope every `gh` query and mutation to repository/head/base, including forks. A failed list call cannot justify create. Multiple matches require explicit selection. The PR draft comes from a pinned current branch/base comparison, with explicitly selected local proposals and relevant run reports as supplementary context. No automatic branch-name ownership resolution and no assumption that the latest run represents the whole branch.

Use the existing bounded model-backed writer pattern for semantic suggestions, normalize conventional type/scope/subject, retain readable word-based titles, and provide a deterministic fallback. Why/What/How-tested formatting remains useful, but missing evidence must be disclosed. Operator text always wins. Headless mode uses explicit text or explicitly accepted generated text, never an interactive editor or an unbounded model wait.

Accepted title/body and inputs live in the unresolved publication operation until success/reconciliation. Retry first locates the existing PR and preserves accepted text for unchanged inputs. A changed source/base requires re-review, not reuse of stale text. Push can be approved as a disclosed prerequisite to PR creation; it is never hidden in a run completion event. A PR-number commit reference does not claim GitHub merged the PR.

### D7. Archive and squash remain separate operations

Archive selected local changes via OpenSpec, in reviewed order. Default managed archive requires complete known tasks and a clean checkout; a supported incomplete-task override must be explicit, warned, and never described as implementation validation. Do not invent override behavior unsupported by the installed CLI. Query/validate supported archive behavior and inspect actual changed paths and destination. Commit only verified archive output under normal user identity/signing/hooks. Unknown output or unrelated dirt stops for inspection.

Capture selected artifacts and accepted message context only while the operation is unresolved, so archive relocation does not lose the inputs for subsequent squash review. OpenSpec validation is primary; structural name checks alone do not prove requirement-body semantics, and unreadable files are not evidence of removal. Batch archives with overlapping changes require review of order and actual composed output; stop rather than guess when ambiguous.

Squash operates on the entire reviewed branch result. Require the pinned base to be contained in the source or explicitly sync first. Create a private detached candidate checkout using existing allocation/candidate patterns; verify the candidate's parent/tree, normal commit hooks/signing, and source/base freshness. Keep source history unchanged apart from explicit additive sync/archive commits. Use ordinary guarded fast-forward integration into the clean selected base checkout rather than moving a checked-out ref and then trying to reconstruct its files. Fault-test hook failures and base movement; external processes do not honor Convoy locks, so do not claim perfect isolation beyond Git's checks and revalidation.

If content is equal, report no content difference and make no empty commit. Do not infer a prior squash or permit branch deletion on equality alone.

### D8. Close is optional composition; cleanup is independent

Close calls the same review/sync/archive/squash operations, with zero or more explicitly selected archive inputs. It shows the whole-branch diff and requested steps before mutation. Do not add a second close eligibility engine. Preserve checklist progress, bounded asynchronous message composition, inline Accept/Edit/Cancel, cancellation safety, and useful headless output.

Push and cleanup remain optional. Worktree removal retains its branch by default and checks tracked/untracked/ignored content, submodules, locks, active managed writers, and current target identity. Valuable ignored content blocks ordinary removal until dealt with explicitly. Force removal exists only as an explicitly consented path disclosed after an ordinary removal is blocked: a deliberate confirmation names exactly what would be deleted (uncommitted, untracked, and ignored content), bypasses only content blockers, and never bypasses the main checkout, the process's own checkout, an unverified registration, or a lock — unlock remains the path there — and unknown/unreadable state is never treated as clean. Stale-target revalidation applies identically to ordinary and forced removal. Removal, like close, asks for launch-time confirmation naming the checkout and branch retention. Blockers reach every launching surface through the shared review→execute seam: a blocked menu action shows its blockers as a visible notice (reason plus remediation) instead of writing to an unwritten process stream and silently returning to the menu. Never remove main or the current process checkout; show deferred guarded commands when needed.

Branch deletion is separate. Use normal Git branch safety when history is preserved; after squash, deleting unique history requires a clearly destructive confirmation naming branch and exact tip. Expected-tip checks protect against ref changes, not data loss; check current registrations immediately before deletion and refuse changed/unverifiable state. Remote branch deletion remains outside this flow. Removing a checkout reports exactly that, not Completed or Abandoned.

### D9. Minimal persistence by purpose and lifetime

| Data | Lifetime | Authority |
| --- | --- | --- |
| Worktree inventory, local artifact/PR observations | Session / refresh | Observed facts, refreshed before action |
| Navigation/session hints | Existing small preference/session storage; best effort | UX hints only; cannot create rows, own changes, or authorize mutation |
| Accepted operation plan/journal + protective temporary refs | Until reconciled/completed/cancelled safely | Recovery of that specific unresolved operation only |
| Managed writer claims and mutation leases | Actual managed execution / operation | Coordination, not feature ownership |
| Run metadata, reports, compaction backups/refs | Existing durable run retention | Run history and bounded compaction recovery only |
| Feature records and receipts | Legacy inert files until explicit cleanup | No new discovery, lifecycle, or cleanup authority |

Temporary operations live under `<git-common-dir>/convoy/operations/<operation-id>/`, not in a checkout or its removable administrative directory. Use atomic writes, bounded versioned records, and existing repository mutation coordination. Record intent before effects and acknowledge verified output after. Recovery inspects reality before normal fresh-operation preflight, including archive-before-commit, candidate-before-landing, base-advanced-before-ack, pushed-before-response, and removed-before-ack cases. A missing acknowledgement is not evidence that an effect failed. Uncertainty blocks replay and asks for inspection.

After requested effects are resolved, remove the journal and protective temporary refs; preserve recoverable candidate work while unresolved. If the operator keeps the worktree, successful close still ends its journal; a later cleanup is a fresh explicitly reviewed deletion, not a follow-up authorized by hidden historical evidence. Keep durable run compaction evidence untouched. Do not add a permanent “history.log” or retained success-operation list that recreates work lifecycle by another route.

### D10. Run and conversation context are not another registry

New run metadata records execution provenance and selected inputs, not membership in a live feature. Historical browsing never causes effects, never consults the present branch at an old path as authority, and remains available after checkout removal. Generic finalization retains its existing run-boundary, signing, publication safety, and durable-recovery contracts.

Exact harness-qualified authoring session references remain necessary to resume conversations; retain them as navigation metadata keyed to observed checkout context, not as spec associations. Validate against harness and live Git before resume. When provenance cannot establish the intended target after path reuse, offer explicit session/checkout selection instead of pretending continuity. Client exit is not proof that a managed writer stopped; preserve liveness coordination and service independence. Extract these generic concerns before deleting `feature-lifecycle/`.

### D11. Compatibility should not perpetuate the old model

Keep `convoy control`, `convoy close`, and standalone `convoy spin` only where meaning is clear. Spin remains an explicitly requested proposal-transfer compatibility utility: same deterministic naming, untracked-file transfer, pruning boundaries, and `/move` output, but no registration/adoption. Its partial-transfer recovery becomes an unresolved operation, not a spin feature record. Primary New worktree never automatically transfers changes. The opt-in global wrapper is not silently rewritten by browsing/creation; retain its supported explicit installation behavior.

Retire `feature show/adopt/bind/revise/recover/new-work` and feature-ID selectors with actionable diagnostics. Do not implement aliases that must fabricate associations to work. Documentation must distinguish old capability/file names from the new user-facing vocabulary. No UI label or command is branded Spaces.

## Risks / Trade-offs

- **No historical local-squash certificate** → Accept unknown history; show Git/PR facts and require explicit deletion decisions. Do not rebuild receipt heuristics.
- **Copied changes remain visible in several worktrees** → Label locality clearly and select per action; never infer ownership or silently archive inherited work.
- **Remote/PR freshness and API failures** → Timestamp observations, bounded lazy queries, explicit fetch/refresh, unknown distinct from absence, fresh validation before remote mutation.
- **External Git can race Convoy** → Pin refs, use Git-native guarded operations, revalidate targets, coordinate managed writers, and document the external-process boundary; stop on divergence.
- **Ignored files/submodules may hold valuable content** → Conservative explicit removal checks with a consented force path only after disclosure; ordinary cleanup stays blocked rather than erase unknown content.
- **Broad removal of feature modules breaks unrelated services** → Extract generic storage, writer coordination, session hints, and run recovery first; regression-test before deletion.
- **Legacy pending close can have half-applied effects** → Keep evidence and surface a separate recovery warning; block only conflicting mutations until explicit reconciliation. Do not auto-import old receipts.
- **Canonical Purpose text still names old features** → Delta operations replace requirements, not existing Purpose sections. Keep main specs unchanged in this planning workflow; reconcile descriptive Purpose text at the later spec-sync/archive stage for `feature-lifecycle`, `feature-close`, `feature-spin`, `control-board`, `work-context`, `work-conversations`, and `specs-viewer`, without resurrecting removed requirements. Existing requirement/scenario titles retained as delta anchors are not UI labels or authority to keep the old domain.
- **Changes are large despite simplification** → One coherent change with staged dependencies and removal gates, not several partially compatible domain models shipped indefinitely.

## Migration Plan

1. Build a canonical Git inventory and checkout-local observation/read path with tests; preserve existing runtime behavior during internal development, but do not ship two authoritative boards.
2. Connect Home/spec reader, worktree creation, run preparation, and conversation targeting to explicit checkout selection. Keep existing reader controls and run history stable.
3. Introduce independent operations and reviewed CLI/TUI entry points, extracting useful implementations while correcting their unsafe assumptions.
4. Compose close with temporary recovery and independently confirmed cleanup; fault-test all mutation boundaries.
5. Remove registry readers/writers, feature plan links/gates, global dedup/source overrides, lifecycle summaries, and receipt creation. Audit symbols, help, docs, and runtime write paths for remnants.
6. Do not perform automatic destructive migration. Old feature records/receipts can remain byte-identical and inert. Provide an explicit previewed legacy-data cleanup that only removes listed retired files/refs after proving no unresolved operations depend on them, never the whole common Convoy directory or run backups.
7. Reconcile unresolved legacy operations via explicit inspection and current-state review. Preserve original evidence until acknowledged/reconciled; if incompatible, stop with manual recovery guidance rather than automatic replay.

**Rollback:** Before any new operation runs, reverting the binary/code leaves untouched Git state and inert legacy files available. After new operations, an old binary cannot safely resume the new temporary journals; first resolve/cancel pending new operations and inspect current Git state. No rollback path rewrites branches, restores stale feature associations as authority, or deletes new work. Remove new code through an ordinary code rollback, not through user-data migration.

## Verification Strategy

Use disposable multi-worktree repositories and mocked/bounded hosting adapters. Cover duplicate IDs with different tasks, inherited changes, external archive/deletion/rename/move, detached/locked/missing worktrees, custom bases, no upstream, forks, stale PRs, branch reuse, dirty/ignored content, and managed-writer conflicts. Assert absence of new feature/receipt/ownership writes, not merely correct UI labels.

Fault-inject before and after creation, file transfer, sync, archive/commit, candidate creation, base landing/materialization, push/PR response, checkout removal, branch deletion, and journal deletion. Verify no unintended replay, lost operator data, or permanent success ledger. Keep the existing run-compaction and conversation/terminal-recovery suites green.

Planned repository checks: `bun run typecheck`, focused `bun test` suites as introduced, and the full `bun test`. Validate planning with `openspec validate worktree-control-center --type change --strict --no-interactive`. These are implementation acceptance commands, not a claim that application checks ran during proposal creation.
