## MODIFIED Requirements

### Requirement: Compaction and closing preserve run-linked commit compatibility

Run-linked semantic messages SHALL remain valid inputs to automatic run compaction and whole-branch closing despite multiline bodies and trailers. Every Convoy-created intermediate commit SHALL retain the existing authoritative exactly-one `Convoy-Run: <run-id>` trailer behavior for writable phases, accepted interrupted-phase recovery, and committed human iterations, with no empty commit solely for a trailer. Existing semantic subject shape, `convoy@local` identity, sanitization and length limits, structured-description persistence, bounded details, and honest non-blocking fallbacks SHALL remain effective. Automatic compaction MUST use the originating run's durable boundary and commit provenance rather than selecting all consecutive commits by authorship alone. Whole-branch squash-to-base, whether independent or composed by close, SHALL include the COMPLETE reviewed branch content against the selected base regardless of authorship, selected local changes, or intermediate trailers, and SHALL NOT rewrite source branch history. The resulting operator-authored commits SHALL NOT be required to retain intermediate `Convoy-Run` trailers. A run compaction's replacement relationship MUST remain recoverable through durable run-specific backups, endpoint evidence, and finalization journals, independently of feature metadata. Close SHALL NOT create or require durable landing receipts, feature associations, or ownership records; its minimal operation journal SHALL live outside any checkout it may remove, reconcile uncertain effects after crashes before retry or cleanup, and be deleted after resolution. Deleting that temporary journal SHALL NOT delete durable run-compaction evidence. Existing user identity, signing, hooks, dirty-tree, managed-writer, and operation-time safety guards SHALL remain effective. The retired `convoy finish` command SHALL NOT remain an execution path.

#### Scenario: Automatic compaction sees run-linked commits

- **WHEN** the verified current-run interval contains `convoy@local` commits with semantic subjects, multiline details, and authoritative `Convoy-Run` trailers
- **THEN** automatic finalization selects only that interval without admitting older runs solely because their author is also Convoy, and retains its durable recovery evidence

#### Scenario: Close replaces intermediate history

- **WHEN** close squash-lands a branch containing operator commits, run-linked intermediate commits, and edits outside the explicitly selected local archive changes
- **THEN** the base gains an operator-authored squash-merge commit covering the whole reviewed branch content without copying intermediate trailers or rewriting source commits

#### Scenario: Close is interrupted after landing

- **WHEN** a close operation may have landed its squash or removed the checkout before the coordinator stopped
- **THEN** the surviving operation journal outside that checkout allows reconciliation of actual Git effects before retry or cleanup, without a durable landing receipt or duplicate squash

#### Scenario: Resolved close journal is removed

- **WHEN** close effects are reconciled and the operation is resolved
- **THEN** its temporary journal is deleted while original source history is not rewritten and any run-specific backup refs, retained phase endpoints, and compaction journals remain available under their own retention rules

#### Scenario: Legacy semantic commits remain usable

- **WHEN** a run contains existing authoritative `Convoy-Run` trailers but feature registry data has been retired
- **THEN** its messages remain readable and compatible with run-specific recovery and eligible compaction without requiring an association, a receipt, or manual finish
