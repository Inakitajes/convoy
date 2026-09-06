## Context

Today two text surfaces are derived from the prompt document (`prd.md` is the verbatim prompt): run titles (`runTitle` in `src/runs.ts`, `runTitleFrom` in `src/finalization/compact.ts` — both recompute the first heading on every read; nothing is persisted) and PR text (`prBody` in `src/publish.ts` — first heading as title, `Run: <title>` plus the first 40 lines of `SUMMARY.md` as body). Meanwhile the semantic artifacts Convoy already holds are good: feature branches are model-named or `<prefix>/<change-id>` (`src/worktree.ts`), changes carry proposal titles (`titleFromProposal`, `src/openspec.ts`), and the shared branch↔change rule is `branchIdFromBranch` (`src/openspec.ts`), already used by the control board. Subject-length tooling exists (`capSubjectWithin`, `firstMeaningfulLine`, `stripControlBytes` in `src/commit-text.ts`). Run metadata is created once at `openRunMetadata` (`src/metadata.ts`, `newMetadata`) and read back everywhere; `RunMetadata` has no title field today. `createPublishSeam` is constructed with `cwd` = target directory (the worktree for isolated runs) and `runDir` = the run workspace, so both the change tree and run reports are reachable from the publish seam without new plumbing. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- One dependency-light title-resolution module used by every title consumer, with the precedence: change proposal title → humanized branch slug → prompt first line.
- Persist the resolved title once at metadata creation; discovery prefers it, never recomputes for runs that have one.
- Publish composes a conventional PR title and a structured Why/What/How-tested body deterministically from persisted context, with per-source mechanical fallback.
- Zero new model calls; no new config surface.

**Non-Goals:**
- No model-composed PR text (a possible later extension layered on the same composer; the deterministic text is the contract).
- No changes to commit-message composition (`commit-message.ts`, `step-commit.ts`), feature-close messages, branch naming, or terminal-title identity.
- No migration of legacy run records; no `RunMetadata.schemaVersion` bump (new field is optional and unknown-field-tolerant readers keep working).
- Custom pipelines' `gh pr create --fill` steps are untouched; this only changes Convoy's own publish composition.

## Decisions

**D1 — One pure title module, three consumers.** New module (e.g. `src/run-title.ts`, importing nothing heavier than `commit-text.ts`-level helpers) exposing `humanizeBranchSlug(branch)` and `resolveRunTitle({ changeTitle, branch, prompt })`. Consumers: the metadata writer (persistence), `runs.ts`, and `compact.ts`. *Alternative considered:* fixing each consumer in place — rejected; three sites already disagree subtly (only `runs.ts` truncates) and would drift again.

**D2 — Persist the title in `RunMetadata` at creation.** `newMetadata` gains optional `title`; `openRunMetadata` resolves it once (branch from the workspace, prompt from the workspace prompt document, change title via D3) and writes it. Discovery readers (`runs.ts` history rows, `compact.ts` history entries) prefer the stored field. *Alternative:* lazy resolution with a cache-on-read — rejected: rewriting records during browse violates the "merely browsing an old run MUST NOT mutate it" principle, and `prd.md` can be rewritten by a goal-loop reset, so recompute-then-store can flip a title mid-run.

**D3 — Resolution inputs and fallbacks.** Change title: `branchIdFromBranch(branch)` gives the change id; reuse the existing proposal-title reader the control board uses (`titleFromProposal`-backed) against the target directory's `openspec/changes/<id>/`; unreadable or missing proposal → next source. Branch: drop the conventional `type/` prefix, replace `-`/`_` with spaces, collapse whitespace, strip control bytes; the slug is already clean (naming went through `cleanBranchName`/kebab). Prompt: `firstMeaningfulLine` of the prompt document, as today. Display truncation (60 chars) stays a consumer concern, not the module's. *Alternative:* model-naming runs without branches — rejected: violates the zero-model goal; the prompt fallback only ever fires for worktree-less runs.

**D4 — PR composition stays inside the publish seam, synchronous.** Replace `prBody` with a composer over `{ cwd, runDir, branch }` (all already available in `apply()`):
- *Title*: type from a recognized conventional prefix on `plan.branch` (`feat`, `change`, `fix`, or another conventional type); no prefix → no fabricated type. Subject: change proposal title (D3 lookup) else humanized slug. Whole line bounded with `capSubjectWithin` at 72. The prompt's first line is never consulted.
- *Why*: the change proposal's Why section; else an excerpt of the prompt document capped to a short paragraph (the operator's stated intent is the why for non-change runs).
- *What*: the run's distilled recap report (`reports/run-reporter.md` when the pipeline produced it); else the persisted finalization commit message body; else the current `SUMMARY.md` excerpt (existing behavior, retained as the last fallback).
- *How tested*: report sections of test/validation steps (`reports/<step>.md` whose step name contains `test` or `validator`, case-insensitive); when none exist, an explicit line disclosing that no test/validation report was produced.
- *Shape*: the three `##` sections; the `Run: <title>` line disappears; every section capped so the body stays a summary. *Alternative:* compose during compaction and persist — rejected: publish must work when finalization is blocked or skipped, one synchronous code path serves both, and determinism (below) already guarantees retry stability for free.

**D5 — Determinism over persistence.** Composition reads only state that exists before publication (metadata, change tree, run reports), so equal state yields equal text; the failed-`gh pr create` retry composes the same title/body and its existing-PR check keeps the retry safe. This replaces the earlier idea of persisting PR text at finalization — with a model composer that would matter (latency, cost); with pure file reads it is redundant complexity.

**D6 — Reuse the change-title seam.** The proposal-title lookup reuses the control board's reader rather than re-parsing proposals in publish, keeping one definition of "the change's title" (including its `titleFromProposal` fallback to the id).

## Risks / Trade-offs

- [Step-name heuristic for How-tested misclassifies a custom step] → the section discloses its basis; unknown runs degrade to the explicit not-covered line rather than wrong claims; the substring set (`test`, `validator`) covers every built-in and the common custom names.
- [Humanized slugs can read awkwardly for oddly-named branches] → still deterministic and strictly better than the prompt line; naming already constrains slugs; the change-proposal source outranks it wherever a change exists.
- [Legacy records without `title`] → prd first-line fallback retained in both readers; no migration, no rewrite-on-read.
- [Proposal/report files vanish between composition and `gh` execution] → composition completes before any `gh` call and reads are optional; missing sources fall back per D4, and the publish contract (missing source MUST NOT block publication) is enforced there.
- [Title format divergence from feature-close squash messages] → intentional: run PRs use `type: subject`; close keeps its own specified contract; neither changes the other.

## Migration Plan

No deployment steps: the new metadata field is optional, legacy records keep their fallback, and the composer is internal to the publish seam. Rollback is a plain revert — runs created with a stored `title` remain readable by the reverted code (the field is simply ignored).

## Open Questions

None blocking. The exact cap sizes per body section (Why/What excerpt lengths) are tunable during implementation without touching the specs or the task breakdown.
