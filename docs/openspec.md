# OpenSpec workflows

[Documentation](README.md) · [Convoy](../README.md)

Use a living specification as the contract for implementation and review.

- [OpenSpec-native runs](#openspec-native-runs)

## OpenSpec-native runs

When a repository uses [OpenSpec](https://openspec.dev/), Convoy reads the change contract from the repository instead of a `.convoy/prd-history` entry:

```
openspec/
  changes/<id>/        proposal.md · specs/** · design.md · tasks.md
  archive/<id>/        ignored
  specs/<capability>/  spec.md
```

Selection is explicit: a run's change comes from `--change <id>` (repeatable, in review order) or from a change picked in the launcher, never from discovery. Nothing auto-attaches the only active change, a change named like the branch, or the changes the diff touches. In a repository with an `openspec/` directory, a headless launch must therefore say which it is:

- `--change <id>` (one or more): the changes are the contract; every id must name an active change, or the launch refuses naming it.
- `--manual`: an explicit no-change run, driven by the prompt (or the pipeline's default prompt).
- neither: the launch refuses with "no change is selected: pass --change <id> … or --manual" (or, with no active change at all, "run /opsx:propose first, or pass --manual").

A resumed run keeps the changes frozen into it. With `features.specs: false` none of this applies ([Configuration](configuration.md)).

When a change resolves, Convoy attaches the **spec bundle** — the current `openspec/specs/**` plus the change's proposal, design, tasks, and delta specs — to **every agent step**. The `prd` (30%) and `scope` (10%) quality dimensions are graded against the change's **Requirements/Scenarios** instead of a diff-inferred brief. Convoy never writes the `openspec/` layout: `/opsx:propose` and archiving belong to OpenSpec itself.

The fastest path is the launcher. After you pick a pipeline, the prompt step lists any active OpenSpec changes: pick one and the spec is the contract (no prompt to edit), or choose **Manual prompt** to type a brief yourself.

```bash
# pick a pipeline and an active spec in the launcher
convoy

# or pin one from the CLI — no prompt required
convoy --change add-login -p implement
convoy --change add-login -p review
convoy --manual -p review          # explicitly without a change
```

From an agent session, the [Convoy skill](agents.md) lists the active changes and asks you which one to run against (or none) before it launches; naming the change in your request, `/convoy-implement add-login`, skips the question.

### The specs reader (`convoy specs`)

```bash
convoy specs     # the artifact-focused reader entry
convoy control   # opens the worktree control board instead
```

The artifact-focused reader over the same worktree-rooted inventory: without a selected checkout it shows the Worktrees list; with one selected it opens that checkout's local artifact sections (empty sections, including their titles, are omitted):

- **Active Changes** — the selected checkout's own active OpenSpec changes with their local facts: tasks done/total (or unknown), artifact availability, and independent Git observations. Same-id copies in different checkouts stay independent; file presence is never ownership.
- **Archives** — the checkout's local archived changes, collapsed or loaded on demand.
- **Canonical Specs** — the merged specs under the selected checkout's `openspec/specs/`.

The header names the normalized target project directory. Change and worktree rows retain their useful details preview; when a canonical spec is selected, that redundant preview disappears and the browse list fills the body in wide and compact layouts. Enter a change (or spec) to read it in a full-width pane under a tab strip: one tab per artifact group — Proposal, Design, Tasks, one merged Delta Specs tab (per-capability headings injected), Other when present — switched with `←`/`→` (`h`/`l`) or digits `1`–`9`, scrolled with `↑`/`↓`. Returning from a canonical reader restores the full-body root list. A subject with a single group hides the strip. Press `v` for the fullscreen reader (title bar with `c copy` and scroll position; `v`/`esc`/`q` to close, tabs still switch inside, `c` copies the active tab's markdown through the same clipboard pipeline as the run dashboard), `a` to apply the change in the launcher, `i` to open a standalone OpenCode session on the change's planning files, `q` to quit.

Row actions act on the explicitly selected checkout-local change:

- **`a` — apply** hands the change to the launcher with its checkout-local source preselected.
- **`i` — iterate** opens (or resumes) an authoring conversation on the change's planning files in its checkout.
- **archive** — archives the explicitly selected local change through OpenSpec (`convoy worktrees archive`); inherited or same-id copies elsewhere are never included.
- **`x` — close review** opens the close confirmation for the containing worktree (below).

---

[Back to documentation](README.md)
