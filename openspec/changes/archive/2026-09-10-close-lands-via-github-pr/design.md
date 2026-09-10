## Context

`driveClose` (`src/worktree-commands.ts`) composes close as sync → archive → squash inside `executeReviewed`, with the landing performed by `squashToBase` (`src/worktree-squash.ts`): a guarded candidate commit fast-forwarded into the clean base checkout, journaled intent-first via `createOperation`/`recordStepIntent`/`acknowledgeStep` (steps `candidate`, `land`). PR discovery (`probeClosePullRequest`) already runs `gh pr list --head <branch> --state open` before message review, and `pushCommittedRevision` (`src/operation-handlers.ts`) already implements the guarded non-force push seam with receipt-style reconciliation for uncertain pushes. The close journal survives worktree removal and is reconciled by `convoy worktrees recover --operation <id>`.

## Goals / Non-Goals

**Goals:**
- Linked open PR ⇒ GitHub records the merge (purple merged state, one squash commit authored server-side).
- Local base ends up fast-forwarded to GitHub's squash commit, so local and remote `main` never diverge.
- Keep the existing close pipeline (sync, archive, message review, journal, recovery) intact; only the landing step changes shape.
- Honest narration: the summary claims a hosted merge only after observing it.

**Non-Goals:**
- No `gh pr create`; close never creates a PR (unchanged).
- No PR closure or branch deletion from close; follow-ups stay separate.
- No change to standalone `convoy worktrees push` semantics.
- No merge-commit landing variant (the B1/B2 shapes discussed in planning) — the hosted squash-merge replaces them.

## Decisions

**D1 — Routing criterion is the existing PR probe.** Reuse `probeClosePullRequest`: exactly one open PR on the head branch with usable evidence selects the hosted path; `none`/`unavailable`/ambiguous/merged select the local path (with disclosure). Rationale: the probe already returns number/title/url at exactly the decision moment, and the spec's evidence taxonomy already distinguishes absence from unavailability. Alternative considered: a CLI flag to force a specific path (hosted or local) — declined; opt-out is covered by the interactive "land locally instead" choice plus the single additive headless flag `--local-landing` (D5).

**D2 — Hosted landing is a new close step, not a new command.** `driveClose` gains a landing branch after message review: when `pr.status === "found"`, run `landViaGitHub` (`src/close-hosted.ts`) instead of `squashToBase`. The step set in the journal becomes `["branch-push", "hosted-merge", "base-advancement"]` (local path keeps `["candidate", "land"]`). Rationale: close's transaction, review, and progress plumbing already exist; a separate command would fork the reviewed pipeline. The local squash module stays untouched for the no-PR path.

**D3 — Message review gates the remote effects, unchanged.** The accepted message is split into subject (first line, PR number appended/verified as `(#N)`) and body for `gh pr merge <n> --squash --subject … --body …`. Interactive review happens before any remote effect, exactly as today; explicit `--message` wins verbatim. Rationale: this preserves the design-D4 message gate and makes GitHub's commit identical to the reviewed text.

**D4 — Remote steps reconcile by receipt.** Each journal step records intent before effect and acknowledges with observed facts:
- `branch-push`: intent pins local SHA + `remote:ref`; reconciliation checks `git ls-remote` / push receipt. Reuses `pushRefspec` + `assertNonForceRefspec`; a rejected update stops (no force).
- `hosted-merge`: reconciliation reads `gh pr view <n> --json state,mergeCommit`; `MERGED` with a resolvable merge commit = done (record its SHA); `OPEN` after an error = retry the merge request; any other state (CLOSED, missing PR) = stop with guidance.
- `base-advancement`: fetch + `git merge --ff-only <mergeCommit>`; already containing the commit = acknowledged.
This mirrors the uncertain-push receipt pattern and keeps intent-before-effect intact for remote mutations.

**D5 — Operator agency on the hosted path.** The review surface (TUI checklist + headless plan) names the three remote-involving steps. The interactive message gate offers an explicit "land locally instead" choice; headless honors `--local-landing` (default: hosted when PR detected). Choosing local performs the unchanged local squash and leaves the PR untouched. Rationale: the current `feature-close` requirement forbids automatic hosted merges; the spec keeps that guarantee for the no-PR/declined/unavailable paths.

**D6 — Local base catch-up is fetch + `--ff-only`.** After the hosted merge, fetch the base remote ref and fast-forward the clean base checkout. If the local base cannot fast-forward (local-only commits), stop with remediation rather than merging. Rationale: a merge commit on the base would reintroduce the divergence this change exists to remove.

## Risks / Trade-offs

- [GitHub merge rejected mid-transaction (PR unmergeable, base moved)] → All prior effects (push) are harmless and idempotent; close stops with the blocker, PR and branch unchanged, retry reconciles by receipt (spec: "Hosted landing reconciles uncertain remote effects").
- [`gh` auth/network inside the close transaction] → Only the linked-PR path requires it; the no-PR path keeps zero GitHub mutation dependency, and unavailable evidence falls back to local with disclosure.
- [Push rejection (remote head moved)] → Same behavior as standalone push: stop, no force fallback; recovery reconciles the already-pushed state before any merge request.
- [Message fidelity through `gh` flags] → Subject/body passed explicitly; tested that multi-line bodies and the `(#N)` subject survive GitHub's squash composition.
- [Local base ahead of origin] → Sync step already merges base into source; a diverged local base surfaces at `--ff-only` and stops for renewed review (acceptable: the operator resolves locally).

## Migration Plan

No data migration: the close journal gains new step names only for newly created operations; existing journals reconcile under the old contract. Rollback is reverting the landing-path branch — the local path is byte-for-byte unchanged.

## Open Questions

(none — routing, fallback, and reconciliation semantics are pinned in the specs)
