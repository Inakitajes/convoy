## Context

See proposal.md for motivation and specs/work-conversations/spec.md for the target behavior. The relevant current state:

- All external clients (run-session `[o]`, iterate, claude-code session, authoring conversation) funnel through `openSessionCommand` → `openInHerdr` in `src/terminal-host.ts`.
- `herdr pane split` always launches an interactive login shell; it has no exec-a-command flag (verified against Herdr 0.9.0 `pane split --help`), so Convoy splits, waits for output, then types the command with `herdr pane run`.
- `openInHerdr` passes `--env PATH=<Convoy PATH>` and `--env ZDOTDIR=/var/empty`. The latter suppresses the operator's shell startup so the prompt appears immediately, shrinking the window before `pane run`.
- On macOS, the pane's login shell runs `/etc/zprofile` → `path_helper`, which can place `/opt/homebrew/bin` ahead of the operator's own PATH entries. The operator's startup files are what re-prepend their real toolchain (e.g. `~/.opencode/bin`); suppressing them lets a stale Homebrew `opencode` shadow the operator's working binary, which Herdr reports as `zsh: killed` (SIGKILL 137). This was reproduced: with `ZDOTDIR=/var/empty` the pane resolved `/opt/homebrew/bin/opencode` and died; without it, it resolved the operator's binary and succeeded.

## Goals / Non-Goals

**Goals:**

- The pane loads the operator's normal shell startup, so the launched client resolves as it does in the operator's shell and the pane returns to a normal interactive shell.
- The command is still submitted reliably once the shell is ready, despite startup output.

**Non-Goals:**

- Changing the Zellij, Ghostty, or Terminal.app backends: they already run the command through a non-interactive login shell or a normal terminal window and do not exhibit this problem.
- Adding a user-facing configuration toggle for pane shell behavior.
- Repairing a broken `opencode` binary on any operator's machine; Convoy only stops selecting the wrong one.
- Changing session references, persisted state, or harness protocol.

## Decisions

### D1: Remove the `ZDOTDIR=/var/empty` override

Drop the env pair from the Herdr split so the login/interactive shell loads the operator's configuration. This is the smallest change that restores both the correct executable resolution and the normal post-exit shell.

Alternatives considered:

- **Keep the fast shell and hand off afterwards** (`command; unset ZDOTDIR; exec "$SHELL" -l`): preserves startup speed but keeps a typed, shell-specific escape hatch, and it is visible in the pane. Rejected: clever for the wrong reason; the real cost of the override is correctness, not just the leftover shell.
- **Exec the command so the pane closes on exit**: removes the leftover shell but also removes the readable failure state that the pane intentionally keeps (a failed launch would vanish), and still does not fix PATH resolution under the suppressed shell.
- **Configuration toggle** (`minimal` vs `user` shell): lets the operator opt in, but ships a known-wrong default and adds a second code path to maintain.
- **Upstream Herdr `pane split -- <cmd>` exec support**: the structurally clean answer, but not available in 0.9.0; revisit if Herdr adds it.

### D2: Keep injecting working directory, PATH, and extra environment

Continue to pass `--cwd`, `--env PATH=…`, and per-open env (e.g. `OPENCODE_CONFIG_CONTENT`). The operator's startup may override PATH afterwards, which is exactly what we want; the injection remains the fallback when their startup does not set it.

### D3: Make pane readiness tolerant of real shell startup

The current wait matches the *first* output (`wait-output --regex .`), which was only a proxy for "the prompt appeared" while the startup was suppressed. With a real startup, a banner can match before the prompt and `pane run` could type too early. Replace it with a quiet-settled wait: poll the pane until its output revision stops changing for a short interval, bounded by a timeout, then submit the command; keep the existing retry loop as a safety net. If the timeout elapses the command is still attempted so a slow or silent startup cannot strand the pane.

Alternative considered: match a prompt pattern. Rejected: operator prompts are arbitrary and theme-dependent, so no pattern is reliable.

### D4: Scope the fix to the Herdr backend

Only `openInHerdr` changes. The window backends and Zellij keep their current command construction.

## Risks / Trade-offs

- **Slower pane open** because the operator's startup runs → the readiness wait is bounded and the value is correctness; accepted.
- **Operator startup prints banners or blocks** → bounded timeout still submits the command, and the retry loop covers a missed ready signal.
- **Behavior relied on for speed changes for everyone inside Herdr** → tests and `docs/running.md` are updated to describe the normal shell.
- **A stale/duplicate harness binary on PATH** is a machine condition Convoy cannot fix → the fix makes the pane match the operator's shell, which is the correct contract; operators with a broken Homebrew `opencode` should still reinstall or remove it.
