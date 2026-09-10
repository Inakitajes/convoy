# work-conversations Specification

## Purpose

Let operators create and resume authoring conversations within a selected work item and return to Convoy without manually relocating sessions or terminal directories.

Work references the existing `featureId`. Conversation references and navigation preferences extend that feature; they SHALL NOT establish another ownership model or change its contract set as a navigation side effect.

## Requirements

### Requirement: Conversations resume the exact linked session

Convoy SHALL create or reopen authoring conversations through the selected harness's supported public interface using a harness-qualified session reference and a checkout-target locator. These SHALL be navigation metadata only, never feature identity, spec ownership, a registered contract set, or mutation authority. Convoy SHALL NOT introduce a new work UUID, ownership manifest, or domain registry for conversation navigation. Small persisted session-selection or checkout hints SHALL be optional and non-authoritative; exact conversation identity SHALL come from the harness session ID. The default resume action SHALL open the most recently selected authoring conversation for a verified target when that selection is available, with other available authoring conversations accessible; without a verifiable selection Convoy SHALL require explicit session selection rather than guessing. Before resuming, Convoy SHALL validate the session reference, target location, and live Git registration and SHALL NOT substitute an unrelated recent session. Missing or stale targets SHALL refuse resume until explicit valid reselection, without treating path reuse as proof of the same checkout incarnation. Git worktree moves SHALL remain discoverable through Git without binding; any use of a moved location for resume SHALL require verified continuity and harness destination validation. Pipeline phase sessions SHALL remain distinguishable from authoring conversations.

#### Scenario: Resume after restarting Convoy

- **WHEN** Convoy reopens from main and the operator resumes a worktree's conversation with a verifiable session reference and target
- **THEN** the exact harness session opens in the validated checkout with its available history without requiring a feature registry

#### Scenario: Linked session is unavailable

- **WHEN** the harness cannot return the selected session
- **THEN** Convoy reports that session as unavailable and offers explicit new-conversation creation without claiming continuity

#### Scenario: Multiple conversations and phase sessions

- **WHEN** a checkout has two available authoring conversations and a run with phase sessions
- **THEN** the authoring selector exposes both conversations separately from run phase sessions and resumes the explicitly selected reference

#### Scenario: Checkout registration disappeared

- **WHEN** a stored session reference exists but its target is no longer registered in Git
- **THEN** Convoy refuses resume against that stale destination and offers explicit target reselection without borrowing another checkout or creating a tombstone

#### Scenario: Reused path is not the old checkout

- **WHEN** a session's old path now hosts a checkout whose continuity with the prior target cannot be verified
- **THEN** Convoy does not resume automatically and requires explicit valid target selection rather than assuming the same incarnation

#### Scenario: Worktree moved through Git

- **WHEN** Git reports a moved worktree and the operator requests an existing conversation
- **THEN** the new location is discoverable without binding, but resume occurs only if target continuity and the harness destination validate; otherwise Convoy refuses the stale target and requires explicit reselection

#### Scenario: Navigation hints are absent

- **WHEN** Convoy reopens without a verifiable last-session hint
- **THEN** it shows available worktrees and explicit session selection rather than creating an identity record or resuming a guessed recent conversation

### Requirement: Foreground conversations return to their work

The default interactive presentation SHALL open the harness client in the current terminal. On client exit, Convoy SHALL restore a usable terminal and return to the same verified worktree and focused checkout-local change, if any, with refreshed independent Git, spec, publication, and activity information. If the target disappeared or cannot be verified, Convoy SHALL return to the Worktrees list with an explanation and SHALL NOT silently select another execution target. Normal exit, startup failure, non-zero exit, interruption, and terminal resize SHALL preserve usable input, echo, and rendering. Entering and leaving a conversation SHALL NOT require changing the parent shell's directory or invoking another Convoy instance. Navigation SHALL NOT infer ownership or expand the set of changes selected for another action.

#### Scenario: Conversation ends normally

- **WHEN** an operator leaves the foreground client after editing a proposal
- **THEN** Convoy shows that same verified worktree and local selection with refreshed artifacts and usable navigation

#### Scenario: Client fails or is interrupted

- **WHEN** the foreground client fails to start, exits non-zero, or is interrupted after the terminal was handed over
- **THEN** Convoy restores terminal input and rendering and reports the outcome within the selected worktree context if still valid, otherwise in the Worktrees list

#### Scenario: Terminal is resized during conversation

- **WHEN** the terminal is resized while the harness client owns it and the operator returns
- **THEN** Convoy renders at the current size without stale input handlers or broken screen state

#### Scenario: Target disappears during conversation

- **WHEN** the selected worktree is removed from Git inventory while its foreground client is open
- **THEN** client exit restores the terminal and returns to the current Worktrees list with an explanation, not a replacement checkout or a durable missing-worktree record

### Requirement: Conversation lifetime is independent of pipeline runs

A conversation's harness session identity SHALL outlive an individual run or Convoy UI attachment without relying on a persistent feature identity. Closing a client view SHALL NOT by itself be reported as evidence that the agent stopped. Convoy SHALL distinguish view detachment from explicit stop, retain required execution services while execution is active, and query actual session availability on reopen. If active execution cannot continue after a requested service shutdown, Convoy SHALL require an explicit stop or keep the service alive rather than silently terminate it. Session availability SHALL NOT alone establish that its previous checkout remains valid for resume or mutation.

#### Scenario: A pipeline finish screen closes

- **WHEN** a run's dashboard closes while an independent authoring conversation exists
- **THEN** closing the run does not invalidate the conversation's harness identity or terminate its required service

#### Scenario: Client detaches during active execution

- **WHEN** an authoring client disconnects while its agent remains active
- **THEN** Convoy reports active execution separately from the detached view and keeps required services alive

#### Scenario: Service shutdown would stop active execution

- **WHEN** the operator requests shutdown of a service required by an active authoring session
- **THEN** Convoy requires an explicit stop decision or retains the service rather than silently terminating execution

### Requirement: External presentation is explicit and truthful

Convoy SHALL retain an explicit option to open an authoring conversation in a supported external window or pane, using the same validated checkout target and exact harness session reference as foreground presentation. Successful pane creation SHALL NOT alone be reported as successful session startup. Externally presented conversations SHALL remain discoverable for their verified checkout through session navigation without requiring feature ownership records. Pane visibility and attachment SHALL NOT replace actual session availability or execution activity observations, and external presentation SHALL obey the same target validation and managed-writer guards.

#### Scenario: External pane opens but harness startup fails

- **WHEN** a window backend creates a pane but the harness does not become available
- **THEN** Convoy does not mark the conversation as successfully running solely from the pane result

#### Scenario: External resume uses the same reference

- **WHEN** the operator explicitly opens a selected conversation in an external pane
- **THEN** Convoy validates and uses the same checkout and exact session reference instead of opening a new or unrelated recent session

### Requirement: Work authoring coordinates with existing writers

Before enabling a managed conversation or pipeline that can write, Convoy SHALL check for conflicting managed writers in the same validated checkout and SHALL preserve shared managed-writer coordination locks independently of any feature registry. It SHALL attach to the appropriate existing session, offer the existing explicit control transition, or report the conflict rather than silently starting a second writer. Closing a launcher or detaching a view SHALL NOT release an execution coordination lock without evidence that execution stopped. A session reference or navigation hint SHALL NOT grant writing authority, bypass normal permissions, or bypass an operation's current guards. Writers in separate checkouts SHALL remain independent even when local change ids match. This guarantee SHALL NOT claim detection of arbitrary unmanaged external processes.

#### Scenario: A run already writes in the selected work

- **WHEN** the operator requests a new writing conversation while a run holds managed execution in that checkout
- **THEN** Convoy offers inspection or an explicit control transition and does not start a concurrent writer automatically

#### Scenario: Another work item is active

- **WHEN** a writer is active in a different checkout
- **THEN** it does not incorrectly block authoring in the selected independent checkout, even if both contain the same change id

#### Scenario: View detaches without stopping execution

- **WHEN** a managed conversation view closes while its agent remains active
- **THEN** the coordination lock remains effective and a second managed writer is not enabled from the view's closure alone

#### Scenario: Resume encounters a conflicting writer

- **WHEN** an exact session reference and target validate but a different managed writer currently holds that checkout
- **THEN** resume does not grant concurrent write access and offers inspection, an explicit control transition, or the shared conflict reason
