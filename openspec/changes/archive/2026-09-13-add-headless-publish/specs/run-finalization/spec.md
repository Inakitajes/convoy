## MODIFIED Requirements

### Requirement: Run dashboards delegate independent worktree publication

Run dashboards SHALL expose independent Push and Create PR actions by delegating to the same guarded worktree operations available outside runs; neither operation SHALL require a run or successful run compaction. Existing inspection and navigation SHALL remain available. Run completion, browsing history, and automatic compaction SHALL NOT publish. Headless run completion SHALL provide guidance only unless a separate explicit publication request exists; `convoy publish` SHALL be that request for a run, and it MUST NOT perform any effect without explicit authorization. Push SHALL work without GitHub CLI or GitHub authentication, subject to ordinary Git transport authentication and current safety checks, and SHALL use a disclosed repository, remote, source branch, destination branch, and explicit non-force refspec without force fallback. Create PR SHALL require a usable GitHub CLI and authentication and SHALL review the repository, remote, head repository/branch, and base repository/branch before any authorized push or PR effect. If a push is needed by Create PR, that push SHALL be explicitly disclosed and authorized through the same Push operation. Neither publication action SHALL delete branches or remove worktrees. Missing GitHub tooling SHALL block only the PR action, not Git push or inspection. Shared dirty-tree, managed-writer, and unresolved-operation guards SHALL remain effective. A pending or uncertain compaction transaction whose safety has not been reconciled MUST block publication regardless of entry point; a safely blocked or failed compaction with history intact SHALL not itself prohibit publication.

#### Scenario: Standalone push without a run or GitHub CLI

- **WHEN** a validated worktree has no runs, GitHub CLI is absent, and the operator authorizes a safe Push
- **THEN** Convoy pushes the reviewed source to the reviewed remote destination with an explicit non-force refspec without requiring run metadata or GitHub

#### Scenario: Dashboard delegates the same operations

- **WHEN** a successful run has safely blocked compaction and the operator opens its dashboard actions
- **THEN** Push and Create PR are independently available subject to the same current worktree guards as standalone actions, with no manual finish step

#### Scenario: Push is rejected

- **WHEN** the reviewed normal push is rejected by the remote
- **THEN** Convoy reports the rejection without force fallback and does not proceed with a PR that depended on that push succeeding

#### Scenario: GitHub CLI is unavailable

- **WHEN** a worktree or run dashboard is viewed without usable GitHub CLI or authentication
- **THEN** Create PR shows actionable setup/manual guidance while Push and inspection retain their own independent availability

#### Scenario: Compaction safety is unresolved

- **WHEN** the selected target has a pending or uncertain compaction transaction whose repository safety has not been reconciled
- **THEN** both standalone and dashboard publication refuse effects and identify recovery as a prerequisite

#### Scenario: Completion is not publication consent

- **WHEN** a run completes in either an interactive or headless session without a separate publication request
- **THEN** no push or PR creation occurs and output only exposes actions or guidance

#### Scenario: Headless explicit publication request

- **WHEN** the operator invokes `convoy publish` for a run with explicit authorization on a safe feature branch
- **THEN** Convoy discloses the reviewed destination and composed title and body, performs the normal push, and creates or reports the pull request, while a run that merely completes still publishes nothing

#### Scenario: Headless publication is inspected before effects

- **WHEN** `convoy publish` is invoked to inspect a run's publication without explicit authorization
- **THEN** Convoy prints the disclosed destination and the composed title and body and performs no push or pull-request effect

### Requirement: PR drafts describe the reviewed current branch

PR composition SHALL use the WHOLE current branch diff against the explicitly reviewed base, supplemented by zero or more explicitly selected checkout-local proposals and optionally relevant run reports or compacted-run messages. Selected proposals and old run results SHALL NOT restrict branch scope or act as sole authority over current content. A selected proposal that is missing or unreadable SHALL stop composition for correction or explicit deselection, without borrowing another checkout's copy. Having no selected proposal or no relevant report SHALL NOT block publication. Convoy MAY use a model to propose semantic text, but model availability SHALL NOT be required: an honest deterministic fallback SHALL derive from the same reviewed diff and available inputs. Titles SHALL be human-readable, conventional, editable, sanitized, and bounded to the shared subject budget with word-boundary shortening; the conventional branch prefix MAY supply a default type without inferring change ownership from the branch slug. Spaces in human titles SHALL remain supported. The body SHALL provide Why, What, and How-tested sections grounded in observed changes, selected proposal rationale, and actual validation evidence. Missing rationale or tests SHALL be disclosed rather than invented, and old run validation SHALL not be claimed to cover newer branch content without supporting evidence. The operator SHALL review and accept the title, body, base, branch scope, and publication destination before effects; the interactive surface reviews them in a dialog, and the headless `convoy publish` surface SHALL print them and require explicit `--yes` authorization before any effect, or compose and print them without effect when asked to inspect only.

#### Scenario: Branch includes work after the run

- **WHEN** the branch includes later operator commits beyond a completed run and only one local proposal is selected
- **THEN** the PR draft describes the entire current diff against the reviewed base, not just that run or proposal, and qualifies any older validation evidence

#### Scenario: Semantic proposal is available

- **WHEN** a model proposes a conventional title and body from the reviewed branch diff and selected local inputs
- **THEN** the operator can edit and accept that text rather than being forced to use an old run's deterministic text

#### Scenario: Model or optional sources are absent

- **WHEN** model composition is unavailable and the worktree has no selected proposals or relevant run reports
- **THEN** Convoy offers a deterministic current-diff-based draft with honest missing-rationale and unverified-testing disclosures for review

#### Scenario: Selected source is missing

- **WHEN** an explicitly selected proposal disappears before its text is captured for review
- **THEN** Convoy stops for correction or explicit deselection rather than silently substituting a same-id source or treating it as an unselected optional source

#### Scenario: Human title contains spaces

- **WHEN** the operator reviews `feat: Improve the worktree review flow`
- **THEN** the human-readable conventional title remains valid with spaces, subject to the shared subject length and sanitization rules

#### Scenario: Headless review then authorize

- **WHEN** the operator runs `convoy publish` for a run and inspects the printed title, body, base, and destination before authorizing it
- **THEN** Convoy applies exactly the reviewed text and destination under that explicit authorization and never publishes from run completion alone
