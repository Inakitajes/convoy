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

The active change is resolved:

1. an explicit `--change <id>` (or a spec picked in the launcher);
2. exactly one non-archived change under `openspec/changes/`;
3. multiple, and the branch name matches a change id (`feat/add-foo` ↔ `add-foo`);
4. multiple, no branch match: compose the changes whose touched files appear in the diff;
5. none: review falls back to today's behavior (default prompt + diff inference), and `implement` refuses with "no change; run /opsx:propose".

When a change resolves, Convoy attaches the **spec bundle** — the current `openspec/specs/**` plus the change's proposal, design, tasks, and delta specs — to **every agent step**. The `prd` (30%) and `scope` (10%) quality dimensions are graded against the change's **Requirements/Scenarios** instead of a diff-inferred brief. Convoy never writes the `openspec/` layout: `/opsx:propose` and archiving belong to OpenSpec itself.

The fastest path is the launcher. After you pick a pipeline, the prompt step lists any active OpenSpec changes: pick one and the spec is the contract (no prompt to edit), or choose **Manual prompt** to type a brief yourself.

```bash
# pick a pipeline and an active spec in the launcher
convoy

# or pin one from the CLI — no prompt required
convoy --change add-login -p implement
convoy --change add-login -p review
```

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
