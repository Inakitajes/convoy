## Why

The interactive close screen has two coherence bugs. First, the archive step runs a `git commit` whose output is inherited by the terminal while the close TUI owns the alternate screen, so git's subject and rename summary are painted over the live interface and the diff-based renderer never repaints the stomped cells; the commit-message review that follows appears entangled with raw git output. Second, after a successful close the completed close screen keeps its key handler installed and consumes every key (`q`, Escape, Enter, Ctrl+C) before the shared-session completion notice can receive it, leaving that notice permanently frozen.

## What Changes

- Suspend the close TUI around every close mutation whose git process inherits the terminal — the archive commit (including the interrupted-archive reconcile commit), as well as the already-covered squash candidate commit and hosted branch push — so git output never paints over the live alternate screen.
- Release the close screen's input ownership before the post-close notice is shown, so the completion/cancellation notice receives `q`/Escape/Enter/Ctrl+C and can be dismissed.
- Keep the close progress and failure surfaces readable as before; headless close is unchanged.

## Capabilities

### New Capabilities

<!-- None: both fixes refine existing close behavior. -->

### Modified Capabilities

- `feature-close`: Close's interface coherence while inherited-terminal git effects run, and the input ownership/dismissibility of the close completion notice.

## Impact

- `src/worktree-commands.ts` (the close driver's archive step and the post-close notice handoff).
- `src/close-tui.ts` (the terminal-suspension seam and input release).
- No CLI surface or headless-output change.
