# Implementation checklist — `worktree-control-center`

Task 1.1 artifact: the capability-to-implementation map for all 14 delta
capabilities of this change, plus the shared checkout-scoped routing contract
(design D4). Canonical specs are intentionally untouched in this step; this
file only records where each delta lands so later tasks can be checked off
against a single list.

## Shared routing contract (design D4)

Every delta consumes the same layers; no capability keeps a private resolver:

1. **Inventory** — `src/worktree-inventory.ts`: one `git worktree list
   --porcelain -z` parse of the whole repository (main, external, detached,
   locked, prunable, bare, spec-less).
2. **Targets** — `src/worktree-target.ts`: observed checkout targets
   (common dir, checkout path, branch/detached, HEAD OID) and fresh-target
   validation with agreeing selectors; no minted identifiers.
3. **Checkout-local artifacts** — `src/checkout-openspec.ts`: active
   changes, archives, and canonical specs read only from the selected
   checkout, keyed by (checkout, local path); no cross-checkout ownership.
4. **Observations** — `src/worktree-observations.ts`: typed, timestamped
   dirt / base / upstream / ancestry / tree-equality / activity facts.
5. **Selection** — `src/change-selection.ts`: explicit ordered
   checkout-local change selection and manual/no-change inputs, shared by
   reviewed actions (archive batch, run inputs) and separate from
   whole-branch Git scope.
6. **Operations** — `worktree-operations` delta: fetch / sync / push / PR /
   archive / squash / remove / delete-branch / recover behind shared guards
   (design D4 command surface). Close composes them (feature-close delta).

## Delta → implementation surface

| # | Delta capability | Primary implementation surface |
| --- | --- | --- |
| 1 | `control-board` | `control-board.ts` rewritten over the shared inventory/targets/observations; `convoy worktrees` primary, `convoy control` alias, `convoy specs` as the artifact-focused reader entry. |
| 2 | `worktree-operations` | New operation modules under `src/worktree-operations/` (inspect/review/execute guards + journals under `<git-common-dir>/convoy/operations/`). |
| 3 | `home-launcher` | `home-tui.ts`: Worktrees-first list from the inventory, New worktree creation flow, contextual action menus. |
| 4 | `work-context` | `work-context` consumers retargeted to `worktree-target.ts`; New worktree creation in the launcher; no feature associations. |
| 5 | `feature-lifecycle` | Retirement path in `src/feature-lifecycle/`: stop consult/author registry; inert legacy files; explicit scoped cleanup. |
| 6 | `feature-spin` | `spin.ts` reduced to explicit legacy proposal transfer with operation-scoped recovery; no registration/adoption. |
| 7 | `feature-close` | `feature-close.ts` / `feature-close-command.ts` recomposed from worktree operations (sync → selected archive → whole-branch squash) with temporary recovery. |
| 8 | `specs-viewer` | `specs.ts` / `specs-browser.ts` on checkout-local readers; `convoy specs` entry behavior per D4. |
| 9 | `run-launcher` | `launch-tui.ts` / `runner.ts`: explicit execution checkout, ordered local change selection (this change-selection layer), no launch-checkout fallback. |
| 10 | `run-finalization` | `finalization/`: run-bounded compaction unchanged; publication delegated to independent push/PR operations; feature linkage removed. |
| 11 | `work-conversations` | `conversation-service.ts` / `conversations.ts`: harness-qualified session references keyed to validated checkout locators; writer coordination extracted (task 2.1). |
| 12 | `worktree-location` | `worktree.ts` allocation conventions unchanged; discovery/lookups switched to the inventory instead of branch-derived paths. |
| 13 | `run-titles` | `run-title.ts`: first titled explicitly selected local proposal → humanized actual branch → prompt line. |
| 14 | `step-commit-messages` | `step-commit.ts` / `commit-message.ts`: unchanged trailer/subject rules; compaction and close consume them without durable feature-close evidence. |

## Sequencing guardrails (design migration plan)

- New layers land beside legacy consumers; a consumer is only switched after
  its replacement and regression tests pass (task 8.4).
- No canonical-spec edits happen during implementation; Purpose text is
  reconciled at the later sync/archive stage (design Risks).
- Legacy feature records stay byte-identical and inert; unresolved legacy
  operations are inspected, never auto-imported (task 2.5).
