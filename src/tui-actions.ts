import type { TextChunk } from "@opentui/core"

import type { AutoAcceptMode, KeepAwakeState, RunControlState } from "./progress"
import type { ContentTab } from "./tui"
import type { HintStyle, HintTone } from "./tui-theme"

/**
 * The dashboard's keyboard surface, in one place.
 *
 * It used to live in four hand-maintained copies — the key handlers, the footer
 * hint strings, the command palette's list, and the palette's help screen — and
 * they drifted: the help screen still advertised three content tabs after a
 * fourth was added, and the palette hid every finish-screen action behind a
 * `!finished` gate, so a finished run offered exactly one command. Everything
 * now derives from `dashboardActions`, which reports the whole catalog and marks
 * what the current state can reach:
 *
 * - footer hints  → `available` and `hint`
 * - palette list  → `available` and `label` (runnable)
 * - shortcuts view → everything with `keys` (a reference table, so it lists
 *   actions the current state can't reach and says when they apply)
 *
 * The key handlers in `tui.ts` stay the routing authority; this describes what
 * exists, it does not dispatch.
 */
export type ActionGroup = "navigation" | "run" | "session" | "finish" | "permissions" | "review"

export type ActionID =
  | "select"
  | "scroll"
  | "read"
  | "leave"
  | "tab-cycle"
  | "page"
  | "jump"
  | "tab-session"
  | "tab-reports"
  | "tab-logs"
  | "tab-advisor"
  | "session"
  | "fullscreen"
  | "copy-report"
  | "pause"
  | "permissions"
  | "keep-awake"
  | "interactive"
  | "usage"
  | "background"
  | "commands"
  | "help"
  | "abort"
  | "iterate"
  | "lazygit"
  | "create-pr"
  | "close"
  | "permission-choose"
  | "permission-confirm"
  | "permission-once"
  | "permission-always"
  | "permission-reject"
  | "permission-escape"
  | "permission-auto-accept"
  | "permission-inspect"
  | "permission-explain"
  | "review-continue"
  | "review-open"
  | "review-abort"
  | "review-retry"
  | "review-reset"

export type Action = {
  id: ActionID
  group: ActionGroup
  /** Reachable from the state that produced this catalog. */
  available: boolean
  /** Key cap as shown. Absent for palette-only commands (nothing is bound). */
  keys?: string
  /** Footer wording. Absent keeps it out of the footer. */
  hint?: string
  /** Palette wording. Absent means documented only — not runnable from the palette. */
  label?: string
  /** Palette's right-hand column. */
  detail?: string
  /** Shortcuts-view wording. Absent keeps it out of that table. */
  help?: string
  /** Order of sacrifice in a narrow footer; 0 is pinned. */
  priority: number
  tone?: HintTone
  style?: HintStyle
  /** Footer label with its own colors (the live auto-accept status). */
  labelChunks?: TextChunk[]
}

export type DashboardActionState = {
  finished: boolean
  observer: boolean
  contentFocused: boolean
  selectedGroup: boolean
  fullscreen: boolean
  contentTab: ContentTab
  permissionPending: boolean
  humanReviewGate?: "interactive" | "failure" | "budget-gate" | "review"
  /** Whether a failure gate can offer [r]: true only when a baseline snapshot exists. */
  reviewCanRetry: boolean
  /** First-attach aborts; a menu-opened controller detaches to the runs menu. */
  ctrlC: "abort" | "detach"
  autoAccept?: AutoAcceptMode
  keepAwake?: KeepAwakeState["status"]
  controlState: RunControlState
  canPause: boolean
  canKeepAwake: boolean
  /** Whether the host wired a background handler (a controller attach has one; a bare in-process dashboard does not). */
  canBackground: boolean
  /** Whether the host wired the publication seam (a deliberate Create pull request action). */
  canPublish: boolean
  interactiveArmed: boolean
  reportCopyable: boolean
  /** Rendered by the caller, which owns the auto-accept colors. */
  autoAcceptChunk?: TextChunk
}

const tabActions: ReadonlyArray<{ id: ActionID; keys: string; tab: ContentTab }> = [
  { id: "tab-session", keys: "1", tab: "session" },
  { id: "tab-reports", keys: "2", tab: "reports" },
  { id: "tab-logs", keys: "3", tab: "logs" },
  { id: "tab-advisor", keys: "4", tab: "advisor" },
]

export function dashboardActions(state: DashboardActionState): Action[] {
  // A permission prompt or a review gate owns the whole keyboard: the footer
  // must show what answers the question, not what would navigate behind it.
  const modal = state.permissionPending || state.humanReviewGate !== undefined
  const live = !state.finished && !modal
  const navigable = !modal && !state.fullscreen
  const reading = navigable && state.contentFocused
  const piloting = navigable && !state.contentFocused

  return [
    // ── navigation ────────────────────────────────────────────────────────
    {
      id: "select",
      group: "navigation",
      available: piloting,
      keys: "↑↓",
      // Arrows-to-move is obvious; keep it out of the footer.
      help: "select a step (or j / k)",
      priority: 2,
    },
    {
      id: "scroll",
      group: "navigation",
      available: reading,
      keys: "↑↓",
      hint: "scroll",
      help: "scroll the reader when it has focus",
      priority: 2,
    },
    {
      id: "read",
      group: "navigation",
      available: piloting,
      keys: "enter",
      // Enter-to-open is obvious; keep it out of the footer.
      help: "focus the reader panel",
      priority: 4,
    },
    {
      id: "tab-cycle",
      group: "navigation",
      available: piloting,
      keys: "←→",
      // Left/right-to-switch-tabs is obvious; keep it out of the footer.
      help: "switch content tab (or h / l / tab)",
      priority: 6,
    },
    {
      id: "page",
      group: "navigation",
      available: reading,
      keys: "pgup/pgdn",
      hint: "page",
      help: "page the reader (space pages down)",
      priority: 4,
    },
    {
      id: "jump",
      group: "navigation",
      available: reading,
      keys: "home/end",
      help: "jump to the start or end of the reader (or g / G)",
      priority: 7,
    },
    {
      id: "leave",
      group: "navigation",
      available: navigable && (state.contentFocused || !state.finished),
      keys: "esc",
      hint: state.contentFocused ? "pipeline" : undefined,
      help: state.finished ? "leave the reader" : "leave the reader, or resume auto-follow",
      priority: 8,
    },
    ...tabActions.map((tab): Action => ({
      id: tab.id,
      group: "navigation",
      available: navigable,
      keys: tab.keys,
      label: `${tabLabel(tab.tab)} tab`,
      detail: state.contentTab === tab.tab ? "showing" : "switch to it",
      help: `show the ${tab.tab} tab`,
      priority: 8,
    })),

    // ── session ───────────────────────────────────────────────────────────
    {
      // A group has no single session to open, so the key is withdrawn and the
      // footer says what to select instead (the caller's row prefix).
      id: "session",
      group: "session",
      available: navigable && !state.selectedGroup,
      keys: "o",
      hint: state.contentFocused ? undefined : "session",
      label: "Open session",
      detail: "the selected step's session window",
      help: "open the selected step's session",
      priority: 3,
    },
    {
      // Reachable while reading too, and the old footer advertised it there.
      id: "fullscreen",
      group: "session",
      available: navigable && !state.selectedGroup,
      keys: "v",
      hint: `full ${state.contentTab}`,
      label: "Fullscreen reader",
      detail: `read ${state.contentTab} full width`,
      help: "open the fullscreen reader",
      priority: 7,
    },
    {
      // No palette label on purpose: the palette can't be opened from the
      // fullscreen reader, which is the only place this key exists.
      id: "copy-report",
      group: "session",
      available: state.fullscreen && state.contentTab === "reports" && state.reportCopyable,
      keys: "c",
      help: "in fullscreen: copy the report to the clipboard",
      priority: 5,
    },

    // ── run ───────────────────────────────────────────────────────────────
    {
      id: "keep-awake",
      group: "run",
      available: live && !state.observer && state.canKeepAwake,
      label: "Keep Mac awake",
      detail: state.keepAwake === "on" ? "on · release Caffeinate" : "off · prevent screen sleep",
      priority: 9,
    },
    {
      id: "pause",
      group: "run",
      available: live && !state.observer && state.canPause,
      keys: "p",
      label: state.controlState === "running" ? "Pause pipeline" : "Resume pipeline",
      detail: state.controlState === "running" ? "after the current batch" : "resume now",
      help: "pause or resume the pipeline",
      priority: 9,
    },
    {
      id: "permissions",
      group: "run",
      available: live && state.autoAccept !== undefined,
      keys: "shift+tab",
      hint: state.autoAccept === undefined ? undefined : "auto-accept",
      labelChunks: state.autoAcceptChunk ? [state.autoAcceptChunk] : undefined,
      style: "spaced",
      label: "Permission policy",
      detail: state.autoAccept === undefined ? undefined : `${autoAcceptModeLabel(state.autoAccept)} · cycle`,
      help: "cycle the permission policy",
      // The footer is the only place this state is shown. While permissions are
      // being auto-accepted that is worth a slot ahead of the navigation keys;
      // with it off there is nothing to warn about, so it yields like the rest.
      priority: state.autoAccept === undefined || state.autoAccept === "off" ? 6 : 2,
    },
    {
      id: "interactive",
      group: "run",
      available: live && !state.observer,
      keys: "i",
      label: "Interactive takeover",
      detail: state.interactiveArmed ? "armed for selected step" : "selected running step",
      help: "take over the selected running step",
      priority: 9,
    },
    {
      id: "usage",
      group: "run",
      available: navigable,
      keys: "u",
      hint: "usage",
      label: "Usage and credits",
      detail: "subscription and wallet meters",
      help: "show subscription and credit usage",
      priority: 9,
    },
    {
      // Palette-only, no key binding (Ctrl+P opens the palette, not the
      // background command). Releases this terminal; the coordinator keeps
      // running and `convoy runs` can re-attach with the same controls. Only
      // offered when the host wired a handler — otherwise the command would
      // close the palette and silently do nothing.
      id: "background",
      group: "run",
      available: live && !state.observer && state.canBackground,
      label: "Send to background",
      detail: "release this terminal · recover from runs",
      priority: 9,
    },
    {
      id: "commands",
      group: "run",
      available: navigable,
      keys: "ctrl+p",
      help: "open this command palette",
      priority: 0,
    },
    {
      id: "help",
      group: "run",
      available: true,
      label: "Keyboard shortcuts",
      detail: "show all controls",
      priority: 9,
    },
    {
      // On a first-attach dashboard Ctrl+C aborts (today's muscle memory); on
      // a menu-opened controller it detaches back to the runs menu instead.
      // When detaching, the palette gains "Abort the run" — the full phrase is
      // the list item, and Enter on it opens a y/n confirm modal, so "a"+Enter
      // can never kill a run. Observers never get the label: their Ctrl+C only
      // detaches, so offering an abort that cannot abort would be a lie.
      id: "abort",
      group: "run",
      available: live,
      keys: "ctrl+c",
      hint: state.ctrlC === "detach" ? "detach" : "abort",
      style: "spaced",
      tone: "yellow",
      label: state.ctrlC === "detach" && !state.observer ? "Abort the run" : undefined,
      detail: state.ctrlC === "detach" && !state.observer ? "end the pipeline · y/n confirm" : undefined,
      help: state.ctrlC === "detach" ? "detach to the runs menu; abort needs the palette confirm" : "abort the run",
      priority: 1,
    },

    // ── finish screen ─────────────────────────────────────────────────────
    {
      id: "iterate",
      group: "finish",
      available: state.finished && navigable,
      keys: "i",
      hint: "iterate",
      label: "Iterate in a new session",
      detail: "reopen the work in a fresh session",
      help: "iterate in a fresh session",
      priority: 5,
    },
    {
      // Only while piloting: with the reader focused, [g] jumps to the top.
      id: "lazygit",
      group: "finish",
      available: state.finished && piloting,
      keys: "g",
      hint: "lazygit",
      label: "Open lazygit",
      detail: "inspect the branch in a subshell",
      help: "open lazygit",
      priority: 6,
    },
    {
      // The sole publication action (capability run-finalization, design D5):
      // the manual finish and its standalone push/PR follow-ups are gone.
      id: "create-pr",
      group: "finish",
      available: state.finished && navigable && state.canPublish,
      keys: "f",
      hint: "pr",
      label: "Create pull request",
      detail: "push the branch and open a PR",
      help: "create a pull request",
      priority: 3,
    },
    {
      id: "close",
      group: "finish",
      available: state.finished && navigable,
      keys: "q",
      hint: "close",
      label: "Close the dashboard",
      detail: "leave the finish screen",
      help: "close the dashboard",
      priority: 2,
    },

    // ── permission prompt ─────────────────────────────────────────────────
    {
      id: "permission-choose",
      group: "permissions",
      available: state.permissionPending,
      keys: "←/→",
      hint: "choose",
      style: "spaced",
      tone: "dim",
      help: "move between the answers",
      priority: 4,
    },
    {
      id: "permission-confirm",
      group: "permissions",
      available: state.permissionPending,
      keys: "enter",
      hint: "confirm",
      style: "spaced",
      help: "send the selected answer",
      priority: 3,
    },
    {
      id: "permission-inspect",
      group: "permissions",
      available: state.permissionPending,
      keys: "i",
      hint: "nspect",
      style: "glued",
      help: "open the opencode session that asked",
      priority: 3,
    },
    {
      id: "permission-explain",
      group: "permissions",
      available: state.permissionPending,
      keys: "e",
      hint: "xplain",
      style: "glued",
      help: "ask the safety judge why",
      priority: 3,
    },
    {
      id: "permission-once",
      group: "permissions",
      available: state.permissionPending,
      keys: "o",
      hint: "nce",
      style: "glued",
      help: "allow once",
      priority: 2,
    },
    {
      id: "permission-always",
      group: "permissions",
      available: state.permissionPending,
      keys: "a",
      hint: "lways",
      style: "glued",
      help: "always allow",
      priority: 2,
    },
    {
      id: "permission-reject",
      group: "permissions",
      available: state.permissionPending,
      keys: "r",
      hint: "eject",
      style: "glued",
      help: "reject the request",
      priority: 1,
    },
    {
      id: "permission-escape",
      group: "permissions",
      available: state.permissionPending,
      keys: "esc",
      hint: "rejects",
      style: "spaced",
      help: "reject and dismiss",
      priority: 5,
    },
    {
      // The same key as the run-control entry, but a different affordance: the
      // handler checks it before the queue, so here it answers the open prompt
      // by flushing the whole queue rather than just setting a policy.
      id: "permission-auto-accept",
      group: "permissions",
      available: state.permissionPending && state.autoAccept !== undefined,
      keys: "shift+tab",
      hint: "auto-accept",
      style: "spaced",
      help: "turn on auto-accept and flush the queue",
      priority: 4,
    },

    // ── human review gate ─────────────────────────────────────────────────
    {
      id: "review-continue",
      group: "review",
      // [c] is never offered on a failure gate: taking control ([o]) then
      // continuing at the flipped interactive gate is the only safe way forward.
      available: !state.permissionPending && state.humanReviewGate !== undefined && state.humanReviewGate !== "failure" && state.humanReviewGate !== "budget-gate",
      keys: "c",
      hint: "continue",
      style: "spaced",
      help: "continue the run",
      priority: 1,
    },
    {
      id: "review-open",
      group: "review",
      available: !state.permissionPending && state.humanReviewGate !== undefined && state.humanReviewGate !== "budget-gate",
      keys: "o",
      hint: "open session",
      style: "spaced",
      help: "open the session",
      priority: 2,
    },
    {
      id: "review-abort",
      group: "review",
      available: !state.permissionPending && state.humanReviewGate !== undefined,
      keys: "a",
      hint: "abort",
      style: "spaced",
      help: "abort the run",
      priority: 3,
    },
    {
      id: "review-retry",
      group: "review",
      available: !state.permissionPending && state.humanReviewGate === "failure" && state.reviewCanRetry,
      keys: "r",
      hint: "retry clean",
      style: "spaced",
      help: "retry the step from a clean baseline",
      priority: 1,
    },
    {
      id: "review-reset",
      group: "review",
      available: !state.permissionPending && state.humanReviewGate === "budget-gate",
      keys: "r",
      hint: "reset and continue",
      style: "spaced",
      help: "reset the phase step budget and re-prompt it",
      priority: 1,
    },
  ]
}

/**
 * The catalog is written in footer order — left to right along the row. The
 * palette wants a different one: what you reach for most, first. Run control
 * leads, then the finish-screen actions, then reading, then the tab jumps, with
 * "Keyboard shortcuts" pinned to the bottom where it has always been.
 */
const paletteRank: Record<ActionGroup, number> = { run: 0, finish: 1, session: 2, navigation: 3, permissions: 4, review: 5 }

export function comparePaletteActions(left: Action, right: Action): number {
  return paletteWeight(left) - paletteWeight(right)
}

function paletteWeight(action: Action): number {
  return action.id === "help" ? 9 : paletteRank[action.group]
}

export function autoAcceptModeLabel(mode: AutoAcceptMode): string {
  if (mode === "all") return "allow all"
  if (mode === "smart") return "smart"
  return "ask every time"
}

const groupTitles: Record<ActionGroup, string> = {
  navigation: "Navigate",
  session: "Read & sessions",
  run: "Run control",
  finish: "Finish screen",
  permissions: "Permission prompt",
  review: "Review gate",
}

export const shortcutGroupOrder: ReadonlyArray<ActionGroup> = ["navigation", "session", "run", "finish", "permissions", "review"]

export function shortcutGroupTitle(group: ActionGroup): string {
  return groupTitles[group]
}

function tabLabel(tab: ContentTab): string {
  return `${tab.charAt(0).toUpperCase()}${tab.slice(1)}`
}
