# Permissions and safety

[Documentation](README.md) · [Convoy](../README.md)

Control agent actions, protect commits, and understand finalization and publication.

- [Permission gate](#permission-gate)
- [Commit safety](#commit-safety)

## Permission gate

Agents run with a restricted bash policy: a small allowlist of safe Flutter/Dart, web/Node, test/build, and read-only git commands; a denylist of unambiguously dangerous patterns (`git push*`, `gh*`, deployment/publish commands, `sudo*`, recursive deletes against `/` or `~`, `curl … | sh`, package installers); and everything else falls through to `ask`.

When an agent runs a command that isn't on the allowlist, Convoy prints the request and prompts:

```
approve? [o]nce, [a]lways, [r]eject >
```

- `o` allows the single call.
- `a` allows future calls matching the same pattern for the rest of the run.
- `r` rejects the call (the agent receives a denial and decides what to do next).

In non-interactive runs (no TTY), unknown commands are auto-rejected and logged. Per-project, extend the lists with `permissions.allow`/`permissions.deny` in `.convoy/config.yaml`; the global policy lives in `src/agents.ts` (`bashPolicy`).

Convoy also allowlists the target repo's own `package.json` scripts whose names look like checks (`test`, `lint`, `typecheck`, `type-check`, `check`, `build`, `format`, `validate`, including suffixed forms like `test:unit`), excluding anything whose name suggests side effects (`deploy`, `publish`, `release`, `migrate`, `seed`, `reset`). Note the trust model: agents can edit the repo, including script bodies, so allowlisted scripts mean trusting the repo's contents — the denylist protects against accidents, it is not a security boundary against a malicious agent.

### Auto-accept (`--yolo` / `--smart` / `Shift+Tab`)

The permission gate has three states. In the dashboard, `Shift+Tab` cycles through them (`off → auto-accept → smart → off`) and the footer always shows the current one:

- **off** — every request that would normally *ask* prompts you.
- **auto-accept** (`--yolo`) — every ask-level request is allowed automatically (replied as "once") and logged to the activity feed. Switching into this state also resolves any prompts already queued.
- **smart** (`--smart`) — each request is handed to an external AI judge running *outside* the agentic loop (a single stateless prompt with every tool disabled, so it can only classify, never act). Requests it judges safe — read-only, local, reversible, no secrets, no exfiltration — are auto-allowed with the reason logged; anything it flags as risky (or any judge error/timeout) falls back to prompting you, with the flag shown in the modal. It is deliberately fail-closed: uncertainty never auto-approves.

The judge model is `--smart-model <provider/model[#variant]>`, falling back to `defaults.autoAcceptJudgeModel` in config, then the run's model. The hard denylist is never relaxed: OpenCode rejects it before the gate, including for read-only steps that have `verify: true`. `--yolo` and smart auto-accept only cover the "ask" bucket.

**In the launcher**, the same choice is a single cycling control. The options step's **permission selector** replaces the old pair of mutually exclusive toggles: activating it cycles Interactive → Auto-accept → Smart auto-accept → Interactive, and it starts on **Auto-accept** — a launcher-launched run defaults to `--yolo` unless you move the selector to Smart auto-accept or back to Interactive (which sends neither flag and prompts for every ask-level request). The row always names the current state and description, the review shows the resolved permission state before anything starts, and the dashboard's `Shift+Tab` cycle plus the CLI flags behave exactly as described below.

## Commit safety

Before each commit Convoy scans the staged files for common secret names (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `*.keystore`, ...). If any match, the commit is aborted, the index reset, and Convoy asks you to add them to `.gitignore` (or delete them) before re-running. Combined with `--include-dirty` this is the only line of defense against accidentally publishing a secret your working tree had lying around — review the resulting commits with `git show` before pushing.

Convoy's commits are always unsigned (`--no-gpg-sign`) and authored by `convoy <convoy@local>`. They are machine commits: with a global `commit.gpgsign = true`, an unattended run would otherwise stall on an interactive signing prompt (1Password, gpg-agent) until it times out and takes the whole pipeline down — and the signature would not verify against that identity anyway. Committing is Convoy's job, so agents are denied `git commit` alongside `git push`. When a run completes successfully, its commits compact automatically into one conventional commit of your own (see [Finishing a run](#finishing-a-run)).

### Step commit messages

Every intermediate commit Convoy creates — a writable phase's clean finish, a recovered interrupted phase, and each committed human iteration — carries the run that produced it:

```text
convoy(<step>): <semantic subject>

- <concrete detail>
- <concrete detail>

Convoy-Run: <complete run ID>
```

- **The trailer.** Convoy, never agent content, writes exactly one `Convoy-Run` trailer with the run's complete ID, so history answers "which run made this commit?" mechanically:

  ```bash
  git log --grep '^Convoy-Run: 20260101-120000-abcd' --format='%h %s'
  ```

- **The subject.** Writable phases can supply an imperative, outcome-oriented subject through an optional `commit: { subject, details }` field on their `write_report` call — one subject, up to three single-line details. Without it, Convoy falls back to the report's first meaningful line (rejecting generic labels like `Implementer report`), then to the exact staged change set (`update src/foo.ts`, a common directory, or a file count), and finally to an honest summary. The complete subject stays within 72 characters; every detail within 120. Recovery reuses a description the phase already submitted.
- **The squash.** None of this changes how a run's commits are compacted or how `convoy close` lands a feature: automatic compaction selects Convoy's commits by the run's recorded ownership (its durable boundary and per-commit `Convoy-Run` provenance, never authorship alone), and the `Convoy-Run` trailers are not required to survive into the resulting operator-authored commit.
- **No empty commits.** A step that leaves no repository changes still commits nothing; the trailer records work, not presence.

### Finishing a run

A successful run used to leave a stack of `convoy(<step>): …` commits: accurate, but not a story, and none of them yours. Now **compaction is automatic**: after the pipeline finishes and any goal settlement has settled — and **before the success post-hooks run**, so a hook that publishes acts on the compacted branch rather than on un-compacted history — Convoy collapses the run's own commits into a single conventional commit created with your git identity. No command, no confirmation, nothing to forget.

- **What it replaces.** Only the commits Convoy recorded for this run, verified against the run's durable start boundary and per-commit provenance — never authorship alone. Your own commits, other runs' commits (including failed ones), and unexpected merges are never rewritten; if anything unaccounted-for sits inside the interval, compaction refuses the whole rewrite and reports why instead of silently squashing a partial range. Commits already published on a remote branch are refused outright rather than requiring a force-push, and unverifiable remote state blocks compaction rather than assuming it is safe.
- **The message.** `defaults.commitMessageModel` reads the run's reports, the PRD, the step commits, and the diffstat, and proposes a conventional commit — subject plus a short bullet body. Compaction is unattended: there is nothing to confirm or edit. A model failure degrades to a message derived from the branch name and step commits; it never blocks the commit.
- **Undo.** Before anything is rewritten, the original commits are protected behind create-only refs under `refs/convoy/runs/<run-id>/…` plus a recovery manifest in the repository's Git common dir, and run history quotes the exact `git diff`/`git show` inspection commands. Recovery is a new branch from the protected tip (`git branch recover/<run-id> refs/convoy/runs/<run-id>/pre-compaction`) — never an automatic reset of a branch that may have advanced.
- **Signing and hooks.** The compacted commit is created with your normal configuration and signing, non-interactively and with bounded deadlines. A signature or hook that requires interaction fails visibly; compaction reports `failed` and keeps the recoverable original history rather than creating an unsigned substitute. Because compaction runs before the success post-hooks, a hook that publishes the branch now pushes the compacted commit; its environment carries the compaction outcome (`CONVOY_FINALIZATION_STATE` and the produced commit) so it can gate on a completed compaction.
- **Transient failures retry.** A remote probe that times out or fails at the transport, authentication, or lookup level is retried with bounded exponential backoff — up to three retries after the initial attempt — before compaction records a terminal outcome. A definite safety refusal (a published replacement commit, a dirty tree, missing boundary or recovery evidence, an unreconciled transaction) is reported immediately and never retried.
- **The outcome is separate.** A safely blocked or failed compaction never turns the run into a failure: the dashboard and summary say `execution succeeded; compaction blocked/failed` with the reason, alongside the pipeline result. Nothing is pushed, no branch is deleted, and no worktree is removed by compaction.

`convoy finish` was removed; invoking it fails with a pointer to automatic compaction and `convoy close`. To land a whole feature's content as one commit on the base branch, run `convoy close`.

### Publishing a run

Compaction never publishes. The only publication action is **Create pull request** (`f` on the finish screen, or the command palette): it discloses the branch, destination remote, and PR base first, then — only on your explicit confirmation — performs one normal push with an explicit refspec and locates or creates the pull request with `gh`. It refuses to guess: a dirty or detached worktree, a base branch, no remotes, several remotes without an upstream, a missing `gh`, or missing `gh` authentication all stop with concrete remediation instead of a pushed branch. Push rejections are reported as-is — there is no force-push fallback — and a pull-request failure after a landed push is retryable without a duplicate, because the retry locates the existing open PR before creating one. The action is unavailable while a run's compaction transaction still needs recovery.

During a human step, Convoy waits indefinitely for an explicit action: `c` continues the pipeline (committing any manual changes), `o` opens an OpenCode window attached to the run's server (resuming its latest session, so the iteration keeps the run's context), and `a` aborts the run. A committed iteration is an intermediate commit like any other: it describes the staged paths (or the changed-file count) instead of a fixed label, and it carries the run's `Convoy-Run` trailer.

### Migration and rollback

Moving from the old `convoy finish` workflow is mostly automatic, but a few old artifacts and in-flight states deserve a look before you upgrade.

- **Existing runs from before this version.** They predate the durable run-start boundary and commit ledger, so automatic compaction has no trustworthy boundary for them and reports `compaction unavailable; no evidence` without rewriting anything. They stay readable and resumable exactly as before. To land such a run's content on the base, use `convoy close` — it folds the whole feature regardless of author or whether the run ever compacted. Convoy never retroactively rewrites historical runs, and never infers a missing boundary from an author email alone.
- **Legacy backup refs (`refs/convoy/finish/<branch>`).** Old per-branch finish backups are left untouched. New runs never overwrite them and never share a namespace: each run gets its own create-only evidence under `refs/convoy/runs/<run-id>/…` (original phase/attempt tips plus a pre-compaction tip), so two runs can never clobber each other's recovery history. A legacy backup is still a fine thing to inspect; it just is no longer where new runs put their evidence.
- **Published PR branches.** A branch that already has commits on a remote is never rewritten or force-pushed by compaction. If a run's replacement commit would displace a published commit, compaction blocks and points to `convoy close`, which squash-lands the whole feature without touching published history. The **Create pull request** action only ever does a normal push; an existing open PR is returned rather than duplicated.
- **New-format in-flight transactions.** If a run or close is interrupted mid-transaction (between preparing and recording a compaction result, or between candidate creation and receipt persistence), the journal in the repository's Git common dir records the exact expected original/committed state. Resuming reconciles that journal first and never blindly duplicates or discards work. Do **not** trust a downgraded or older Convoy build to resume a new-format in-flight transaction — downgraded tooling can't read the new journal, and the safe path is to continue with the current version.

**Rollback.** A code rollback preserves the new metadata, evidence refs, and any committed landings; it never rewrites branches automatically to restore the old UX. Inspect a run's pre-compaction history on a recovery branch (`git branch recover/<run-id> refs/convoy/runs/<run-id>/pre-compaction`) or use close's protected feature-tip ref. Reverting a published landing is an ordinary explicit `git revert`, never a force-push. Delete recovery evidence only through a deliberate retention action, not ordinary run cleanup.

---

[Back to documentation](README.md)
