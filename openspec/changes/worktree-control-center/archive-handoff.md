# Post-implementation spec-sync/archive handoff — `worktree-control-center`

This change is **implementation-complete**. Synchronizing its delta specs into
the canonical `openspec/specs/**` (and archiving it) is a **separate, explicit
workflow**; implementation completion does not depend on archiving, and this
document does not mutate canonical specs. It records what the sync/archive step
must reconcile: the canonical Purpose paragraphs that still describe the
**retired** feature lifecycle, and the requirement replacements to preserve.

## Canonical Purpose paragraphs that still describe retired feature behavior

The following canonical `openspec/specs/*/spec.md` Purpose sections and their
requirements still name the retired persistent feature domain (stable identity,
repository-scoped associations, contract sets, lifecycle assessment, receipt
creation). The `worktree-control-center` delta specs replaced these; sync/archive
must rewrite the Purpose text **without resurrecting** the removed requirements.

| Capability | Retired behavior still described by canonical Purpose |
| --- | --- |
| `feature-lifecycle` | "persist its explicit change-contract set, intended local base, current implementation-context association, historical run links, and close-attempt references independently of branch names and worktree paths". |
| `feature-close` | "resolve stable feature identity ... through the shared lifecycle assessment ... unresolved legacy work SHALL require explicit adoption". |
| `feature-spin` | "register the feature's stable identity and association durably as part of a successful spin". |
| `control-board` | "every feature's stage is derived live from git, OpenSpec, run plans, and the repository-scoped feature registry ... registered features and explicit associations provide stable identity". |
| `work-context` | "denotes the existing repository-scoped feature identity in the work-first UI. This capability builds on `stable-feature-lifecycle`". |
| `work-conversations` | "Work references the existing `featureId`. Conversation references and navigation preferences extend that feature". |
| `specs-viewer` | "registered features and active changes (lifecycle work) ... repository-scoped feature associations, referenced archives, run/close evidence ... for lifecycle discovery". |

## Requirement replacements to preserve

When the Purpose text above is rewritten, the canonical requirement/scenario
anchors must reflect the worktree control center, not a renamed registry. The
replacements to keep are the delta behaviors (design D1–D11):

- **`control-board`** → one `git worktree list` inventory; independent typed
  observations (dirt/base/upstream/ancestry/tree-equality/activity); `convoy
  worktrees` primary, `convoy control` alias, `convoy specs` the artifact reader.
- **`worktree-operations`** (new) → guarded fetch/sync/push/pr/archive/run/
  squash/close/remove/delete-branch/recover behind inspect/review/execute guards
  and bounded unresolved-operation journals under `<git-common-dir>/convoy/operations/`.
- **`home-launcher`** → Worktrees-first Home, New worktree reviewed creation,
  contextual action menus; no Spaces/Features branding.
- **`work-context`** → Git-derived explicit checkout targets; no feature
  associations; a worktree is an inventory entry, not a domain record.
- **`feature-lifecycle`** → retire the whole lifecycle; legacy files inert;
  explicit previewed scoped cleanup only.
- **`feature-spin`** → explicit legacy proposal transfer only (naming/prefix
  selection, deterministic naming, untracked-transfer, pruning, opt-in wrapper),
  with operation recovery; no registration/adoption.
- **`feature-close`** → optional composition of sync → selected archive →
  whole-branch squash with temporary recovery; no receipt-based lifecycle closure;
  push/removal/cleanup independently consented.
- **`specs-viewer`** → checkout-local active/archive/canonical reader keyed by
  (checkout, local path); selected-change actions; no ownership resolution or
  global change dedup.
- **`run-launcher`** → explicit execution checkout and ordered local change
  selection; no launch-checkout fallback; explicit headless change/manual mode.
- **`run-finalization`** → run-bounded compaction/provenance preserved; publication
  via independent push/PR operations with the failed-lookup gate and operator
  review step; no feature linkage.
- **`work-conversations`** → exact harness-qualified session refs on validated
  checkout locators; writer coordination extracted; no feature identity.
- **`worktree-location`** → naming/allocation conventions preserved; existing
  targets resolved from Git inventory, not associations.
- **`run-titles`** → first titled explicitly selected local proposal → humanized
  branch → prompt line, persisted once without a model call.
- **`step-commit-messages`** → unchanged trailer/subject rules; compaction and
  close consume them without durable feature-close evidence.

## Sync/archive notes

- `convoy feature`, feature-ID flags, `convoy finish`, and feature registry
  readers/writers must stay retired in the canonical text; "Worktrees" is the
  vocabulary, "Spaces"/"Features" are not.
- Legacy files may remain byte-identical and inert on disk; canonical Purpose
  text describes the current model, not the leftover files.
- Existing requirement/scenario titles retained in delta specs are **anchors**,
  not UI labels and not permission to keep the old domain.
- Execution of sync/archive requires its own explicit workflow
  (`/opsx-sync-specs` / `/opsx-archive`); it is not part of implementation.
