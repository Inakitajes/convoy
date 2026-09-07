# Verification record — tasks 7.1, 7.2, 7.5

Executed 2026-09-07 against the installed OpenCode CLI `1.18.29` / SDK `1.18.4`.
Scripts: `scripts/verify-workflow-e2e.ts` (7.1 headless scenario),
`scripts/verify-execution-legs.ts` (7.1/7.2 execution legs: real propose
invocation, active-detach, real pipeline launch), `scripts/verify-foreground-client.ts`
(7.2 foreground return, run under a real pty via `script -q /dev/null`),
`scripts/verify-multiplexer-pane.ts` + `scripts/verify-multiplexer-layout.kdl`
(7.2 multiplexer success path, run inside a real Zellij session), plus the
scripted delta-overlap check and `openspec validate --strict` (7.5). Every
outcome below is an observed result of those runs; limits are named rather
than marked as passing.

## 7.1 — End-to-end work-first scenario (temporary repository, from main)

`bun run scripts/verify-workflow-e2e.ts` — SCENARIO COMPLETE. Observed steps:

| Step | Outcome |
| --- | --- |
| Create work | `convoy feature new-work --branch feat/widget --worktree <wt> --base main` from the base checkout registered the pre-proposal feature (`displayName "new work (feat/widget)"`, context = the worktree, branch `feat/widget`). |
| Board from main | Piped `convoy specs` from main lists the work with `Awaiting proposal`, its display name, and no control sequences — no `cd` into the worktree. |
| Propose in the worktree | `listAuthoringCommands` through a server booted from the worktree discovers the project's `opsx-propose` (plus the repo's other commands); the proposal session is created in the worktree's project (`ses_…` id returned). |
| Leave / reopen the exact conversation | The linked reference (`harness: opencode` + session id) is stored under the feature's conversation record; after killing the worktree-booted server, a server booted from **main** reopens the exact session id (`session.get` ok, title intact) — no `/move`, no nested Convoy, no directory switch. |
| Pipeline destination | `resolveWorkContext({ launchDir: main, featureId })` returns `validated` with `executionCheckout` = the worktree and branch `feat/widget` — a work-scoped launch prepares and executes there without a shell switch. |
| Return | `loadLifecycleFeatureRows(main)` still shows the same feature, summary `Awaiting proposal`, 1 linked conversation, `lastSelectedConversationId` = the proposal session. |
| Side effects | Commit count unchanged (1 before, 1 after); worktree inventory exactly main + the one created worktree. |

### 7.1 execution legs — the propose command and a real pipeline, run for real

`bun run scripts/verify-execution-legs.ts` — LEGS `{"propose":"pass","detach":"pass","pipeline":"pass"}`.
The fixture mirrors the e2e one plus a working OpenSpec root (`openspec init`),
the project's real `opsx-propose.md`, and an unattended-permission `opencode.json`
(recorded, not hidden: without it a server-side agent would block on ask-level
prompts with no client attached).

| Leg | Outcome |
| --- | --- |
| Propose executed | The real `opsx-propose` command was invoked through the supported command API (`POST /session/{id}/command`) and a real agent authored the complete change in the worktree: `add-greeting` with `proposal.md`, `design.md`, `tasks.md`. The branch was never renamed (`feat/widget` before and after). The authored change was then associated through the explicit revise workflow (`convoy feature revise` → revision 2, contract `add-greeting` active) — the differing-change-id review path, exercised for real. |
| Pipeline launched | A real headless Convoy run (`-p verify-e2e --feature <id>`) executed in the worktree and exited 0. Its durable metadata names the worktree as `targetDir` and carries the feature link (`featureId` + `branch feat/widget`) — the work-scoped launch, feature-linked, with no manual `cd`. Along the way the run's own guards fired correctly and were satisfied deliberately: the writer-claim coordination refused a launch while the authoring claim was held, and the dirty-tree gate refused the untracked authored artifacts until they were committed (the operator's normal next step). |

**Finding (needs a product decision, flagged not fixed):** `session.command`
executes the authoring agent **synchronously** — the invocation call blocked
for the whole authoring pass (observed 186s–480s across runs) and returned
only after the artifacts existed. The shipped `invokeAuthoringCommand` doc
assumes asynchronous execution ("the foreground client is how the operator
watches and steers it"); against opencode 1.18.29 the operator would instead
stare at the suspended Convoy terminal for the whole authoring duration before
the client opens on the finished work. The feasibility note (task 2.3)
deliberately never executed the command, so this is the first observed
execution. Related observed fact: a `promptAsync` run DOES report `busy` in
`session.status()`, so the activity seam itself works — the gap is specific to
the command path's synchronous shape.

## 7.2 — Terminal return, active-detach, multiplexers, two-work concurrency

`script -q /dev/null bun run scripts/verify-foreground-client.ts` — PROBE
COMPLETE. Observed:

| Leg | Outcome |
| --- | --- |
| Real-client foreground return | The real interactive client (`opencode <worktree> --session=<id>` — the exact argv `authoringClientArgv` builds) ran as the foreground child: the probe's watchdog observed it **still running** at t+3s, delivered SIGINT (the signal Ctrl+C produces), and the client exited 0. The host recorded `suspend` → `resume`, renderer alive (not destroyed), dimensions preserved (80×24), input alive. |
| Two-work concurrency | Writer claims are scoped per checkout branch: claim on `feat/fg-probe` acquired; claim on the independent `feat/second-probe` worktree acquired; a second writer on the *same* checkout is refused (`conflict`). |

### 7.2 execution legs — active-detach with a live agent

Verified in `scripts/verify-execution-legs.ts` against a genuinely live agent:
while the propose agent was executing server-side with **no client attached**
(the active-detach shape), `sessionActivity` reported `busy` and the claim was
kept (the idle release is gated on activity — a busy session is never
released); after the agent settled, the same release path removed the claim
(`released: true`). Observed on every execution-legs run.

### 7.2 multiplexer leg — the success path inside a real Zellij session

`scripts/verify-multiplexer-pane.ts`, launched as a pane of a real Zellij
session (`zellij --session convoy-verify-mux --new-session-with-layout
scripts/verify-multiplexer-layout.kdl` under a pty). Observed:

| Step | Outcome |
| --- | --- |
| Environment | `insideZellij: true` — the probe ran inside the multiplexer, so the zellij backend was detected the way an operator's session would be. |
| External pane success | `openConversationExternal` returned `{ status: "opened", backend: "zellij" }`: a new pane was created running the real `opencode <worktree> --session=<id>` client, and the linked session was verified through the authoring server — the honest contract (pane created + session resolvable; the pane's client itself remains unobservable). |

The session was killed and deleted after the probe. Combined with the failure
path already recorded below (forced zellij with no live session → `failed`,
never claimed running), both external-presentation outcomes are now observed.

Remaining limits, recorded honestly:

- **Foreground client steering during a live propose** — because the command
  path is synchronous (finding above), the operator-visible "watch the agent
  author in the foreground client" experience cannot occur as shipped; that
  is the flagged product decision, not a missing measurement.
- Probe-harness note: an earlier foreground-probe iteration fell through the
  *unforced* backend detection to macOS Terminal.app (a window opened on this
  machine; its stray client processes were killed). The committed scripts
  force or host the backend deliberately so they can never open a real window
  on the operator's desktop.

## 7.5 — Delta-overlap validation against the synchronized baseline

- `openspec validate unify-work-context --strict` → **valid** (run after the
  corrections below; also valid before them).
- Scripted comparison of every delta requirement against the canonical specs:
  every MODIFIED requirement in `control-board`, `feature-spin`, `home-launcher`,
  and `specs-viewer` retains **all** upstream scenarios (control-board 2/2,
  4/4, 3/3, 2/2, 3/3, 1/1, 1/1; feature-spin 1/1; home-launcher 5/5;
  specs-viewer 3/3, 5/5, 4/4, 3/3, 3/3, 2/2, 3/3). No ownership or evidence
  guarantee was removed; new scenarios only extend.
- The four home-launcher requirements absent from the delta are exactly the
  four declared under `## REMOVED Requirements` with stated reasons and
  migrations (destination poster, diamond selector, graphics poster,
  centered description) — intentional removals, not omissions.
- One stale delta operation found and corrected: control-board's "Board
  assessment can be refreshed without changing selection identity" was marked
  `## ADDED` although the stable-feature-lifecycle archive (commit `168cbb6`)
  had already synchronized it into the canonical spec (content identical). It
  is now `## MODIFIED`, so archiving this change can no longer collide with
  the existing canonical requirement.
- Required synchronization order (unchanged): `stable-feature-lifecycle` is
  already synchronized (canonical `feature-lifecycle`, `feature-close`,
  `control-board`, … as of `168cbb6`); this change archives after it, never
  before, so its overlapping deltas modify — not restore — the implemented
  contract.
