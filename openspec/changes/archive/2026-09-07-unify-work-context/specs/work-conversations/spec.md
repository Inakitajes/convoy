## Purpose

Let operators create and resume authoring conversations within a selected work item and return to Convoy without manually relocating sessions or terminal directories.

Work references the existing `featureId`. Conversation references and navigation preferences extend that feature; they SHALL NOT establish another ownership model or change its contract set as a navigation side effect.

## ADDED Requirements

### Requirement: Conversations resume the exact linked session
Convoy SHALL create or reopen authoring conversations through the selected harness's supported public interface and retain a harness-qualified session reference associated with the work. The default resume action SHALL open the most recently selected linked authoring conversation, with all other linked conversations accessible. Convoy SHALL validate the reference and destination before resuming and SHALL NOT substitute an unrelated recent session. Pipeline phase sessions SHALL remain distinguishable from authoring conversations.

#### Scenario: Resume after restarting Convoy
- **WHEN** Convoy reopens from main and the operator resumes a work item's conversation
- **THEN** the exact linked session opens in the work's validated checkout with its available history

#### Scenario: Linked session is unavailable
- **WHEN** the harness cannot return the stored session
- **THEN** Convoy reports that session as unavailable and offers explicit new-conversation creation without claiming continuity

#### Scenario: Multiple conversations and phase sessions
- **WHEN** work has two authoring conversations and a run with phase sessions
- **THEN** the authoring selector exposes both conversations separately from run phase sessions and resumes the selected reference

### Requirement: Foreground conversations return to their work
The default interactive presentation SHALL open the harness client in the current terminal. On client exit, Convoy SHALL restore a usable terminal and return to the same selected feature and focused contract with refreshed shared lifecycle assessment, Git, spec, and run information. Normal exit, startup failure, non-zero exit, interruption, and terminal resize SHALL preserve usable input, echo, and rendering. Entering and leaving a conversation SHALL NOT require changing the parent shell's directory or invoking another Convoy instance.

#### Scenario: Conversation ends normally
- **WHEN** an operator leaves the foreground client after editing a proposal
- **THEN** Convoy shows that same work with refreshed artifacts and usable navigation

#### Scenario: Client fails or is interrupted
- **WHEN** the foreground client fails to start, exits non-zero, or is interrupted after the terminal was handed over
- **THEN** Convoy restores terminal input and rendering and reports the outcome within the selected work

#### Scenario: Terminal is resized during conversation
- **WHEN** the terminal is resized while the harness client owns it and the operator returns
- **THEN** Convoy renders at the current size without stale input handlers or broken screen state

### Requirement: Conversation lifetime is independent of pipeline runs
A conversation's persisted identity SHALL outlive an individual run or Convoy UI attachment. Closing a client view SHALL NOT by itself be reported as evidence that the agent stopped. Convoy SHALL distinguish view detachment from explicit stop, retain required execution services while work is active, and query actual session availability on reopen. If active execution cannot continue after a requested service shutdown, Convoy SHALL require an explicit stop or keep the service alive rather than silently terminate it.

#### Scenario: A pipeline finish screen closes
- **WHEN** a run's dashboard closes while an independent authoring conversation exists
- **THEN** closing the run does not invalidate the conversation's identity or terminate its required service

#### Scenario: Client detaches during active execution
- **WHEN** an authoring client disconnects while its agent remains active
- **THEN** Convoy reports active execution separately from the detached view and keeps required services alive

### Requirement: External presentation is explicit and truthful
Convoy SHALL retain an explicit option to open a linked conversation in a supported external window or pane, using the same validated work and session reference. Successful pane creation SHALL NOT alone be reported as successful session startup. Externally presented conversations SHALL remain discoverable under their work.

#### Scenario: External pane opens but harness startup fails
- **WHEN** a window backend creates a pane but the harness does not become available
- **THEN** Convoy does not mark the conversation as successfully running solely from the pane result

### Requirement: Work authoring coordinates with existing writers
Before enabling a managed conversation or pipeline that can write, Convoy SHALL check for conflicting managed writers in the same checkout. It SHALL attach to the appropriate existing session, offer the existing explicit control transition, or report the conflict rather than silently starting a second writer. Closing a launcher or detaching a view SHALL NOT release ownership without evidence that execution stopped. This guarantee SHALL NOT claim detection of arbitrary unmanaged external processes.

#### Scenario: A run already writes in the selected work
- **WHEN** the operator requests a new writing conversation while a run owns execution in that checkout
- **THEN** Convoy offers inspection or an explicit control transition and does not start a concurrent writer automatically

#### Scenario: Another work item is active
- **WHEN** a writer is active in a different checkout
- **THEN** it does not incorrectly block authoring in the selected work's independent checkout
