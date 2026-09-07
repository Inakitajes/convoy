# Design: close-confirmation-and-pr-link

## Context

Close is local-first: it lands one squash commit on the local base ref via a
guarded `git update-ref`, and push/worktree/branch cleanup are printed
follow-ups that the operator runs deliberately (spec `feature-close`, design
D9). The only GitHub interaction in the codebase today is `publish.ts`
(`gh pr create`/`gh pr list` on the run finish screen). The specs browser hands
`x` straight to `runCloseCommand` — `specs-browser.ts` root `case "x"` and
`dispatchMenuItem` case "close" — so the sequence (sync → archive →
squash-merge) starts without a question; the message-review gate happens only
after archive has mutated the worktree.

GitHub marks a pull request *Merged* when it performed the merge or when the
PR's head commits become reachable from the base (merge/rebase ancestry). A
local squash commit is a new object with no ancestry link, so GitHub can never
detect it. GitHub's own squash merge appends ` (#N)` to the commit subject, and
a pushed commit whose subject carries that reference is attributed to the PR
and marks it merged — this is the established convention for landing PRs from
a local squash (the same pattern GitHub's UI generates). Nothing in the API
allows asserting merge state directly, so the reference is the only way to get
the *Merged* badge from a local landing; a deliberate `gh pr close` fallback
covers the residual risk.

## Goals / Non-Goals

**Goals**

- Close discloses an open PR for the feature branch and gives GitHub what it
  needs to mark it merged when the operator pushes.
- The follow-up block covers the residual case with a deliberate fallback
  command; nothing remote is ever done automatically.
- A stray `x` in the specs browser can no longer start the close sequence.

**Non-Goals**

- Landing through the GitHub merge API (`gh pr merge`) or restructuring close
  around a hosted merge; close stays local-first.
- Automatic pushes, automatic PR closes, or asserting hosted merge state (the
  spec forbids asserting it; close reports what it detected, nothing more).
- Confirmation gates on other browser actions (`a` apply, `m` archive-on-main,
  `s` spin) or on the headless `convoy close` CLI surface.

## Decisions

- **D1: Probe with `gh pr list`, tolerate every failure.** During the
  squash-merge step, before composing the message, close runs
  `gh pr list --head <branch> --state open --json number,title,url --limit 1`
  in the main checkout through the existing `execFile` seam with
  `allowFailure`. Any non-zero exit, missing binary, timeout-free parse
  failure, or empty result means "no detected PR": no disclosure, no failure,
  close proceeds. The probe runs once per close attempt, only when a landing
  is about to happen (not on `already-landed`/no-change dispositions, where no
  new landing occurs). *Alternative considered:* probing in preflight so the
  disclosure appears earlier — rejected because preflight failure must stay
  cheap and side-effect-free, and the PR only matters when the landing runs.

- **D2: The reference rides the composed subject, applied at composition.**
  `composeCloseMessage` gains the detected PR number in its context and
  appends ` (#N)` to the subject line of the formatted proposal (trimming the
  subject part so the whole first line stays within the existing cap when
  possible). Applying it at composition means: the operator sees the exact
  subject during review (no invisible transformation between review and
  landing), the journal persists it across resume, and the template fallback
  gets it too. An operator edit that removes it is respected — the reviewed
  value is authoritative; close never re-appends. `--message` keeps winning
  verbatim (spec invariant SC-8) and gets no suffix; the follow-up fallback
  covers that path. *Alternative considered:* appending after review
  acceptance — rejected as dishonest: what the operator reviewed would differ
  from what lands.

- **D3: PR facts travel on `CloseResult`.** The probe result lands on the
  result event as `pullRequest?: { number; title?; url }`, so both surfaces
  that resolve follow-ups (headless `formatCloseEvents`, interactive
  `runCloseInteractive`) get it without a second probe. `resolveCloseFollowUps`
  accepts it and emits a `prFallback` entry: the printed command
  `gh pr close <N> --comment "landed in <base> as <sha>"` plus the PR URL. It
  is rendered as guidance (headless follow-up block; interactive follow-ups
  notice) — not a selectable TUI action — because, unlike worktree/branch
  cleanup, it has no local git evidence to revalidate and the push must happen
  first anyway.

- **D4: Confirmation as a pending-resolution modal in the browser.**
  `SpecsBrowser` gains a `pendingClose` state holding the would-be resolution
  plus display facts (feature display name/id, branch, `view.baseBranch`,
  active change id). Root `x` (all three branches of the current handler) and
  the Actions menu's close dispatch set the state instead of finishing; the
  modal owns the keyboard (`y`/Enter confirms → `finish(resolution)`, `n`/Esc
  cancels → state cleared, selection unchanged). Rendering follows the
  runs-browser retry-confirm pattern (overlay box, theme colors, hints row).
  The modal discloses what the sequence does — "sync → archive → squash-merge
  onto <base>; archives <changeID> and lands one commit" — because that is
  exactly the hard-to-revert part the operator never saw before.

- **D5: Headless/CLI unchanged.** `convoy close` from a pipe keeps its
  non-interactive contract (agents and scripts rely on it); the confirmation
  is a browser-surface guard. The TTY close surface already has its own gates
  (preflight blockers, message review).

## Risks / Trade-offs

- [GitHub's `(#N)` squash detection is a convention, not a documented API
  guarantee; if it fails, the PR stays open] → The follow-up block names the
  PR and prints the deliberate `gh pr close --comment` fallback, so the worst
  case is a closed (not merged) PR, never a dangling open one.
- [The probe adds a `gh` subprocess to every landing] → Single call, ~100ms,
  `allowFailure`, skipped entirely when `gh` is absent; no network call is
  made when the CLI is unauthenticated (it fails fast locally).
- [One more confirmation adds friction for deliberate closes] → One `y` press;
  the modal names what it protects (archive + landing), which is the sequence
  the user cannot easily undo.
- [`--message` overrides get no `(#N)` reference, so GitHub will not mark
  those PRs merged] → The fallback `gh pr close` guidance covers it; changing
  the override would violate the existing verbatim-override spec invariant.

## Migration Plan

No data migration. Existing close journals/receipts are untouched; the new
result field is additive and optional. Rollback is a plain revert.

## Open Questions

None.
