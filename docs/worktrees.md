# Worktrees and delivery

[Documentation](README.md) · [Convoy](../README.md)

Manage work in isolated checkouts, from planning through close.

- [Worktrees: control, spin, close](#worktrees-control-spin-close)

## Worktrees: control, spin, close

A worktree is an ordinary Git checkout, not a registered entity. Convoy keeps no feature registry, contract set, association, or landing receipt: the Worktrees control center (`convoy worktrees`, with `convoy control` as its alias) enumerates every checkout registered in the repository's Git worktree inventory — main, external, detached, locked, inaccessible, and spec-less alike — and derives every displayed fact (branch, dirt, base/upstream divergence, pull-request observations, tasks, run liveness) from fresh evidence at render time. If a worktree is deleted outside Convoy, the next open simply shows it gone; there is no record to repair. Actions target an explicitly selected checkout and revalidate it immediately before any effect, so a moved or replaced checkout is refused instead of silently mutated.

### The worktree control center: `convoy worktrees`

```bash
convoy worktrees                                   # the inventory / control center
convoy worktrees new <description>                 # describe, review, create a worktree
convoy worktrees fetch --worktree <path> --remote <name>
convoy worktrees sync --worktree <path> --base <ref>
convoy worktrees push --worktree <path> [--remote <name> --ref <local>:<remote>]
convoy worktrees pr --worktree <path> [--base <ref>] [--title <text> --body <text>] [--push]
convoy worktrees archive --worktree <path> --change <id> [--change <id> ...]
convoy worktrees run --worktree <path> [--change <id> ... | --manual]
convoy worktrees squash --worktree <path> --base <local-branch>
convoy worktrees close --worktree <path> --base <local-branch> [--change <id> ...]
convoy worktrees remove --worktree <path>
convoy worktrees delete-branch --branch <name>
convoy worktrees recover --operation <id>
```

The retired `convoy feature` subcommands (`show`, `adopt`, `bind`, `revise`, `recover`, `new-work`) and feature-ID flags fail non-zero with worktree-selection guidance before any effect: checkouts are selected explicitly per action, never adopted, bound, or registered. Legacy registry files under `<git-common-dir>/convoy/` stay inert — they create no rows, no lifecycle, and no cleanup authority — and an explicit previewed cleanup can remove them only after proving no unresolved operation depends on them.

### Work-first Home: create work, talk, then run

Interactive `convoy` opens the **Worktrees list** — every Git-registered checkout with its independent observations — plus a `+ New worktree` entry and the auxiliary destinations (pipelines, specs, runs, config). Work exists before specs do: `New worktree` reviews a name, branch, base, and destination and creates the isolated worktree *before* any authoring agent starts; nothing is committed, no PR is created, and nothing is registered. A worktree with no changes yet is an ordinary peer row — never a lifecycle stage.

Selecting a work item opens its detail, whose rows are grouped into labeled sections — work, git, destructive — followed by two observation sections scoped to that checkout:

- **work** — the OpenCode authoring actions:
  - **Open conversation** (`v`) opens (or resumes the exactly linked) OpenCode authoring conversation in the work's verified checkout, foreground: Convoy hands the terminal over and returns to the same selected work when the client exits, with artifacts and observations refreshed. Linked sessions survive Convoy restarts — the durable reference is the harness id + session id, stored as a non-authoritative navigation hint and re-verified against live Git and the harness before every resume, so any server of the same repository reopens the exact conversation; an unavailable session is reported and replaced by an explicit new conversation, never silently.
  - **Open in window** (`w`) is the explicit external presentation: it opens the same session in a Herdr/Zellij pane or a new terminal window. Pane creation and session availability are reported independently — a created pane whose session cannot be verified never reads as a running conversation, and because pane backends expose no child handle, Convoy cannot observe the pane's client: it asks you to confirm the conversation started there rather than claiming it.
  - **Propose** (`p`) runs the project's own authoring workflow (`opsx-propose` in this repo) inside the work's checkout through OpenCode's command API. If the project has no supported proposal command, Propose says so and ordinary conversation stays usable. Newly authored changes appear under that checkout on return — review them in the Worktrees control center before archiving or running; a differing change id never renames the worktree's branch.
  - **Execute pipeline** (`e`) launches the worktree-scoped pipeline, reusing that checkout's own configuration, spec sources, and explicitly selected local changes.
- **git** — the guarded publication operations (`fetch` `f`, `sync` `y`, `push` `u`, `pr` `g`, `squash` `m`), each delegating to the same CLI command surface with the same guards (inaccessible checkout, detached HEAD, active managed writer).
- **destructive** — the dangerous cluster stays together at the end of the actions, never scattered between the safe ones, led by the deliberate composition: **Close review** (`x`) with its guarded base destination, then **Remove worktree** (`d`) and **Delete branch** (`z`, projected blocked here because this worktree holds the branch).
- **recent runs** — this checkout's own recent runs, requested on entering the detail (by recorded execution directory, else by the durable branch link), each speaking the runs list's status vocabulary (the check, the cross, the half-circle; a live run's green dot) and opening the runs browser focused on that run.
- **linked specs** — this checkout's own active changes under the specs browser's change diamond, each opening the specs browser restored on that change's row. Unknown is never empty: an unreadable change list reports its reason.

Before any managed writer (authoring conversation or pipeline) starts in a checkout, Convoy takes a writer claim scoped to the branch/checkout identity: a live conflicting writer is refused with attach-or-stop guidance, a provably stale claim is reconciled, and an uncertain one is never taken over silently. Authoring conversations run against the repository's own authoring server — discovered via a transient record in `<git-common-dir>/convoy/`, liveness-verified (PID plus URL) before reuse, and independent of run servers and dashboards: closing a run or a client view never stops it, and only an explicit stop with quiescence evidence does. Convoy remembers the last selected checkout per repository as a non-authoritative navigation hint and restores it on reopen only when the live Git registration still verifies it; a selection that no longer resolves is explained rather than silently replaced. Interrupted creation is recoverable: the creation intent is journalled outside the checkout before any effect, and a retry reuses the validated result instead of creating a second worktree.

### Spinning a feature out (`convoy spin`)

```bash
convoy spin                     # resolve the uncommitted change (several → list and stop)
convoy spin --change add-login  # pin the change
convoy spin --prefix fix        # override the inferred conventional prefix
```

Given an uncommitted OpenSpec change on the base checkout, spin creates an isolated worktree on a branch named `<prefix>/<change-id>`, the prefix inferred deterministically from the change's own delta specs: any `ADDED` requirement → `feat`, every requirement `MODIFIED`/`RENAMED` → `change`, only `REMOVED` → `fix` (mixed without an addition, or no deltas yet → `feat`). The worktree location follows the repository's documented worktree convention exactly like launcher-isolated runs. The uncommitted change files move into the worktree (untracked only — committed files stay put and arrive via the base ref), nothing is committed, and the handoff names the directory, the branch, and the next step:

```text
spun out add-login → ~/.convoy/worktrees/feat-add-login
branch: feat/add-login
continue the same OpenCode conversation: run /move and pick the worktree above
```

The operator's OpenCode session relocates with `/move` (OpenCode's own command — Convoy never forks or summarizes a session). If `/move`'s picker doesn't list the fresh worktree, open a session in the printed directory instead. A tree dirty outside `openspec/` refuses to spin; a change already committed on the base branch spins with nothing moved. Spin registers nothing: the created worktree appears through the Git worktree inventory like any other checkout, and no feature record, association, or adoption is involved. If the transfer stops partway, the pending transfer keeps its source/destination evidence until reconciled — moved versus remaining files are reported, and neither copy is overwritten.

The global `/convoy-spin` OpenCode command is opt-in: run `convoy opencode install` once and the thin wrapper at `~/.config/opencode/commands/convoy-spin.md` tells the agent to run `convoy spin` and relay its output, touching no other command files (spin never writes into your global config).

### Closing a worktree (`convoy close`)

```bash
convoy close --worktree <path> --base <local-branch>
convoy close --branch feat/add-login
convoy close --change add-widget          # archive exactly this local change first
```

One reviewed composition of the independent worktree operations, each step checked before it runs:

1. **Review** — the explicit checkout, its actual branch, the selected base, and the explicitly selected archive set (zero is valid) are disclosed before any mutation; selecting changes controls what is archived, never the whole-branch squash scope.
2. **Sync** — merge the base branch into the source branch inside the worktree when the base is not already contained. Conflicts stop with the conflict listed; resolve, commit, and re-run close.
3. **Archive** — through the OpenSpec CLI (`openspec archive`), never by hand: each explicitly selected change moves to the archive layout and the verified output is committed on the source branch under your identity. Incomplete or unknown tasks block the ordinary archive.
4. **Squash-merge** — the whole feature's final content (your commits, run-compaction commits, sync resolutions, and archive output alike) is folded by tree, not by author. Close builds a private detached integration worktree at the pinned base revision, stages the feature's post-archive tree there with `git merge --squash`, scans the staged files for secrets, and creates one operator-authored conventional commit — your identity, your signing, your hooks. The feature branch's own history is never rewritten; nothing about the landing depends on who wrote which commit. That commit's message is composed by a model-backed writer (with a deterministic fallback when no model answers): the scope is always the single touched capability, the subject is a readable imperative line, and the change id is named in the body. The checklist names each squash-merge sub-phase as it happens — composing the message, waiting for your review, creating the landing commit — and the running indicator keeps animating while the writer works, even when nothing new comes back. In a terminal you confirm, edit, or cancel the message before it lands; `--message` overrides it exactly and skips composition.
5. **Land** — the base branch is advanced onto the one verified candidate from the main checkout (which must still sit clean on the exact captured base revision). The candidate has exactly one parent — the pinned base — so landing is a guarded fast-forward-only update that refuses when the base moved (re-run `convoy close` to re-sync against the new base), never an ordinary merge or force update, and the landing commit is named in the result. Close records no permanent receipt: the operation journal is released once the requested steps are resolved, and a later cleanup is a fresh, explicitly reviewed action.

In a terminal the whole sequence runs in a full-screen TUI: completed, skipped (with reason), and failed steps stay visible as they happen; the composed commit message is accepted, edited, or cancelled in the same interface; and push, worktree removal, and branch deletion remain separate actions (`convoy worktrees push|remove|delete-branch`). The TUI stays open on a failure so its remediation can be read. Headless runs print the same facts as a plain stdout summary and attempt nothing interactive.

The message review is a vertical Accept / Edit / Cancel list: `↑`/`↓` (or `j`/`k`) move the selection, `Enter` activates the highlighted choice, and the direct shortcuts `y` / `e` / `n` still work. **Edit opens an inline multiline editor inside the TUI** — no external `$EDITOR` round-trip. Type freely (`Enter` inserts a newline), press `Ctrl+S` to save and return to review, or `Esc` to discard the draft and keep the previously reviewed message. Nothing lands until you explicitly choose Accept, so saving an edit is not a confirmation.

Push, worktree removal, and branch deletion are separate, deliberate actions — never automatic, and never performed by close. Push uses an explicit remote and non-force refspec, and asks for the destination when no upstream is configured. Worktree removal keeps its branch by default and refuses unsafe removals: the main checkout, the current process checkout, locked or prunable registrations, uncommitted tracked/untracked content, valuable ignored files, and submodules with local state each block with their reason — there is no force-removal shortcut. Branch deletion is its own action: the safe form uses Git's unmerged-refusal, and deleting unique history after a squash requires explicit destructive consent bound to the exact reviewed tip (`--force --expect <oid>`, executed as an atomic expected-tip deletion with `git update-ref -d refs/heads/<branch> <expected-tip>`): if the branch moved between review and deletion — for example because new work reused the name — the expected-old value refuses, so the wrong work is never deleted. Headless runs print the equivalent guarded commands in that same safe order.

One cleanup nuance: when close was **launched from inside the worktree it closes**, worktree removal and branch deletion are presented as *deferred guarded commands* — an explanation plus the exact commands in dependency order — rather than as runnable actions. A process cannot remove the directory its own shell sits in, so no amount of navigation inside this session can make those actions runnable; leave the worktree in your terminal first and run the printed commands from outside. Push is unaffected: it is available either way.

### What close's evidence means (and what it doesn't)

Integration facts are kept deliberately orthogonal — none implies another:

- **Tasks complete** is not "ready to close": a live managed writer, an unreadable source, or a dirty tree each blocks the close review with its reason, and the review stays reachable while blocked.
- **Archived** is not "integrated": a change can be archived (including by hand) while its branch is unlanded. The board reports the archive as a local fact and keeps the close review available.
- **A merged PR** is a fact about that PR, never about the current branch: a merged PR for an older head or a reused branch name does not make current work completed, and unavailable PR evidence is never reported as "no PR" or "merged".
- **Equal trees** mean no content difference right now — not that a previous close happened, and never authorization to delete unique history.
- **Landing is reconciled, not receipted**: the base ref moves through a guarded fast-forward and the operation journal records intent before each effect. A crash between steps is reconciled by `convoy worktrees recover --operation <id>` against actual Git state — the journal is released once resolved, and no second commit is ever created for the same landing.

### Isolating a run in a worktree

An isolated run gets a new branch checked out in a dedicated worktree, leaving your current checkout untouched — which is what makes automatic run compaction safely rewritable there (see [Finishing a run](safety.md#finishing-a-run)). Where that worktree lives follows a fixed priority: a `worktree location: ~/dev/worktrees/{repo}/{branch}` marker in `AGENTS.md` or `README.md`, then `defaults.worktreeLocation` in config, then the built-in `~/.convoy/worktrees/<branch>`. `{repo}` and `{branch}` are placeholders; `~` is home. A location without `{branch}` gets the branch slug appended, so each worktree still gets its own directory. A declared location that can't be used falls through to the next one.

**The default depends on where you are.** On a trunk — `main`, `master`, `develop`, `trunk`, or whatever `origin/HEAD` points at — Convoy isolates, because you almost certainly don't want a pipeline committing straight onto it. Once you're on a branch of your own, it runs in place: you already made the branch you want the work on. A detached HEAD isolates too. Force either end per run with `--worktree` / `--no-worktree`, or permanently with `defaults.worktree: true` / `false`; the launcher shows which way the default went and why, next to the toggle. `--branch <name>` pins the name instead of asking the naming model, which is what an unattended or scripted run should use.

The branch is always agreed with you first, in a **Branch** step between Options and Review:

- An `Intended Branch Name` (or `git checkout -b …`) in the prompt is used as-is — the model is not asked to reinvent it. A short prompt that is just a path to a plan file is read first, so pasting `docs/plans/foo.md` still picks up the name inside. Otherwise `defaults.branchNameModel` (DeepSeek V4.1 Flash via OpenRouter by default) reads the prompt and proposes a conventional name — `feat/runtime-guard-limits`, `fix/login-redirect` — always in English, even when the prompt is not, keeping the document's own words rather than paraphrasing them. Prompts that only reference an issue (`#123`, `DEV-1339`, a URL) are looked up first, so the branch is named after what the issue is about.
- The proposed name is shown in an editable field together with the worktree path it would take. Enter accepts it and moves on to Review; nothing is created until you confirm the run there.
- `tab` moves to the **hint** box: describe how you want it named ("name it after the budget limits") and press Enter or `ctrl+R` to re-name it. This is also what you get when the prompt is too thin to name anything, or when the naming model is unavailable — the step still opens, with a name derived from the prompt, ready to be edited.
- Names already taken by a branch or an existing worktree are suffixed (`-2`, `-3`) instead of failing `git worktree add` after the run has been confirmed.

The new branch is created from `HEAD`, so it starts from whatever you have checked out. When the run ends, [automatic compaction](safety.md#finishing-a-run) squashes it into one conventional commit of your own.

---

[Back to documentation](README.md)
