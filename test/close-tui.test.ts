import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { parseKeypress } from "@opentui/core"
import { EventEmitter } from "node:events"

import { CloseTui, type CloseFollowUpItem, type CloseFollowUpsView, type CloseTuiOptions } from "../src/close-tui"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: options.ctrl && name === "c" ? "\u0003" : name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

async function openClose(width = 100, height = 30, input = new EventEmitter(), options: CloseTuiOptions = {}) {
  const testRenderer = await createTestRenderer({ width, height })
  const instance = new CloseTui(testRenderer.renderer, "/workspace/convoy", undefined, input, undefined, options)
  await testRenderer.renderOnce()
  const session = {
    ...testRenderer,
    instance,
    input,
    press(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(name, options))
    },
    /** Feeds raw terminal bytes through OpenTUI's real key parser. */
    feed(sequence: string) {
      const parsed = parseKeypress(sequence)
      if (parsed) testRenderer.renderer.keyInput.processParsedKey(parsed)
    },
    type(text: string) {
      for (const char of text) session.feed(char)
    },
  }
  return session
}

describe("close TUI progress", () => {
  test("renders the event stream as a real full-screen checklist", async () => {
    const session = await openClose()
    try {
      session.instance.onEvent({ type: "preflight", summary: "clean tree · 4/4 tasks · no live runs" })
      session.instance.onEvent({ type: "step-skipped", step: "sync", reason: "main is already an ancestor" })
      session.instance.onEvent({ type: "step-started", step: "archive" })
      await session.renderOnce()

      const frame = session.captureCharFrame()
      expect(frame).toContain("convoy close")
      expect(frame).toContain("/workspace/convoy")
      expect(frame).toContain("clean tree · 4/4 tasks · no live runs")
      expect(frame).toContain("sync — skipped: main is already an ancestor")
      expect(frame).toContain("archive…")
      // The previous pseudo-TUI leaked cursor-up ANSI bytes to stdout. The
      // OpenTUI frame contains only the rendered interface.
      expect(frame).not.toContain("\x1b[")
    } finally {
      session.instance.destroy()
    }
  })

  test("keeps a failed step and remediation visible until dismissed", async () => {
    const session = await openClose()
    try {
      session.instance.onEvent({ type: "step-failed", step: "archive", message: "archive: openspec archive failed" })
      const dismissed = session.instance.showFailure("archive: openspec archive failed\nrun convoy close --resume")
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("close stopped")
      expect(frame).toContain("openspec archive failed")
      expect(frame).toContain("run convoy close --resume")
      session.press("q")
      await expect(dismissed).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })
})

describe("close TUI render ticker", () => {
  // The spinner's time-based frame recomputed against a fake clock, so the
  // frames below are deterministic without a real timer.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test("spinner frames keep changing while composition is deferred (design D2)", async () => {
    let now = 0
    const session = await openClose(100, 30, new EventEmitter(), { clock: () => now, tickMs: 5 })
    try {
      // A deferred writer holds close in `composing-message`: no further
      // operation events arrive, yet the running row must stay visibly alive.
      session.instance.onEvent({ type: "step-started", step: "squash-merge" })
      session.instance.onEvent({ type: "squash-phase", phase: "composing-message" })
      await session.renderOnce()
      now = 0
      const before = session.captureCharFrame()

      now = 150
      await sleep(40)
      const after = session.captureCharFrame()
      // The frame actually moved without any intervening event.
      expect(after).not.toBe(before)
      // The semantic detail is stable across the ticks.
      expect(after).toContain("composing the commit message")
      expect(before).toContain("composing the commit message")
    } finally {
      session.instance.destroy()
    }
  })

  test("the ticker runs only while a row is active and is disposed on teardown", async () => {
    const session = await openClose(100, 30, new EventEmitter(), { clock: () => 0, tickMs: 5 })
    try {
      // Idle rows have no ticker.
      expect(session.instance.ticking).toBe(false)
      session.instance.onEvent({ type: "step-started", step: "squash-merge" })
      expect(session.instance.ticking).toBe(true)
      // Completion stops it; no render cadence survives its work.
      session.instance.onEvent({ type: "step-completed", step: "squash-merge", detail: "done" })
      expect(session.instance.ticking).toBe(false)

      // A second activation survives a suspend/resume cycle (design D2).
      session.instance.onEvent({ type: "step-started", step: "archive" })
      expect(session.instance.ticking).toBe(true)
      await session.instance.withTerminal(async () => {})
      expect(session.instance.ticking).toBe(true)

      session.instance.destroy()
      expect(session.instance.ticking).toBe(false)
    } finally {
      session.instance.destroy()
    }
  })
})

describe("close TUI commit gate", () => {
  test("the vertical Accept/Edit/Cancel selector follows vertical keys and Enter activates it", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({
        message: "feat(cli): improve close\n\n- change close-ui",
        source: "model",
      })
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("commit message")
      expect(frame).toContain("feat(cli): improve close")
      expect(frame).toContain("Accept")
      expect(frame).toContain("Edit")
      expect(frame).toContain("Cancel")
      // The list renders vertically and the marker moves with Up/Down (D3).
      expect(frame).toContain("▸ Accept")
      session.press("down")
      await session.renderOnce()
      expect(session.captureCharFrame()).toContain("▸ Edit")
      session.press("up")
      await session.renderOnce()
      expect(session.captureCharFrame()).toContain("▸ Accept")

      // Down twice lands on Cancel; Enter activates the highlighted choice.
      session.press("down")
      session.press("down")
      session.press("return")
      await expect(decision).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })

  test("accepting returns the reviewed message; direct shortcuts still work", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "fallback" })
      await session.renderOnce()
      session.press("y")
      await expect(decision).resolves.toBe("feat: close")
    } finally {
      session.instance.destroy()
    }
  })

  test("Edit opens the inline editor; saving returns to review without accepting (design D4)", async () => {
    const session = await openClose()
    try {
      let settled = false
      const decision = session.instance.confirmMessage({ message: "feat(cli): original subject\n\n- change add-widget", source: "model" })
      void decision.then(() => {
        settled = true
      })
      await session.renderOnce()
      session.press("e")
      await session.renderOnce()
      expect(session.captureCharFrame()).toContain("edit commit message")

      // Clear the seeded draft through real terminal input and type a new one.
      session.feed("\x1b[F") // end
      session.feed("\x1b[1;2H") // shift+home selects the whole buffer
      session.feed("\x7f") // backspace clears it
      session.type("fix(ui): edited subject")
      session.feed("\r") // enter inserts a newline
      session.type("- edited body")
      session.press("s", { ctrl: true })
      await session.renderOnce()

      // Back on review with the edited value; nothing has landed yet.
      const reviewFrame = session.captureCharFrame()
      expect(reviewFrame).toContain("fix(ui): edited subject")
      expect(reviewFrame).toContain("- edited body")
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled).toBe(false)

      session.press("y")
      await expect(decision).resolves.toBe("fix(ui): edited subject\n- edited body")
    } finally {
      session.instance.destroy()
    }
  })

  test("cancelling an inline edit preserves the reviewed message", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({ message: "feat: original", source: "model" })
      await session.renderOnce()
      session.press("e")
      await session.renderOnce()
      session.type("junk draft")
      session.press("escape")
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("feat: original")
      expect(frame).not.toContain("junk draft")
      session.press("y")
      await expect(decision).resolves.toBe("feat: original")
    } finally {
      session.instance.destroy()
    }
  })

  test("a draft without a subject is refused and the editor stays open", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "model" })
      await session.renderOnce()
      session.press("e")
      await session.renderOnce()
      session.feed("\x1b[F") // end
      session.feed("\x1b[1;2H") // select all
      session.feed("\x7f") // clear
      session.press("s", { ctrl: true })
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("the message needs a subject line")
      expect(frame).toContain("edit commit message")
      // Escape discards the emptied draft; the reviewed message is intact.
      session.press("escape")
      session.press("y")
      await expect(decision).resolves.toBe("feat: close")
    } finally {
      session.instance.destroy()
    }
  })

  test("Ctrl-C cancels before the squash lands", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "fallback" })
      session.press("c", { ctrl: true })
      await expect(decision).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })

  test("terminal EOF cancels the gate instead of hanging", async () => {
    const input = new EventEmitter()
    const session = await openClose(100, 30, input)
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "fallback" })
      input.emit("end")
      await expect(decision).resolves.toBeUndefined()
      // Any later blocking surface resolves immediately after the input died.
      await expect(session.instance.showFailure("terminal closed")).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })

  test("releases and restores the renderer around terminal-owned commands", async () => {
    const session = await openClose()
    let suspended = 0
    let resumed = 0
    session.renderer.suspend = () => {
      suspended += 1
    }
    session.renderer.resume = () => {
      resumed += 1
    }
    try {
      await expect(session.instance.withTerminal(async () => "done")).resolves.toBe("done")
      expect(suspended).toBe(1)
      expect(resumed).toBe(1)
    } finally {
      session.instance.destroy()
    }
  })
})

describe("close TUI follow-ups", () => {
  const outside: CloseFollowUpsView = {
    actions: [
      { id: "push", label: "Push main", detail: "Push to origin with the explicit refspec main:main.", command: "git push origin main:main", status: "available" },
      { id: "worktree", label: "Remove worktree", detail: "/workspace/wt", command: "git worktree remove /workspace/wt", status: "available" },
      { id: "branch", label: "Delete feat/close-ui", detail: "Remove the worktree first.", command: "git branch -d feat/close-ui", status: "blocked" },
    ],
  }

  test("renders blocked same-session dependencies as inert rows and runs only available actions", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(outside)
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("optional follow-ups")
      expect(frame).toContain("Nothing below runs automatically")
      expect(frame).toContain("Push main  available")
      expect(frame).toContain("Remove worktree  available")
      expect(frame).toContain("Delete feat/close-ui  blocked until its dependency clears")

      // Push is selected and available.
      session.press("return")
      await expect(selection).resolves.toEqual({ type: "run", id: "push" })
    } finally {
      session.instance.destroy()
    }
  })

  test("a blocked row is never activated, even when selected (selection boundaries)", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(outside)
      // Move to the blocked branch row; the shortcut also stays inert.
      session.press("down")
      session.press("down")
      session.press("return")
      session.press("b")
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })

  test("deferred cleanup renders as a reason plus ordered commands, outside the action list", async () => {
    const session = await openClose()
    try {
      const view: CloseFollowUpsView = {
        actions: [{ id: "push", label: "Push main", detail: "Push to origin.", command: "git push origin main:main", status: "available" }],
        deferred: {
          reason: "convoy close was launched from inside /workspace/wt. A process cannot remove the directory its shell sits in — leave the worktree in your terminal, then run:",
          steps: [
            { label: "Remove the feature worktree", command: "git -C /repo worktree remove '/workspace/wt'" },
            { label: "Delete the local feat/close-ui branch", command: "git -C /repo branch -d feat/close-ui" },
          ],
        },
      }
      const selection = session.instance.selectFollowUp(view)
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("Deferred cleanup — not runnable from this shell")
      expect(frame).toContain("cannot remove the directory")
      expect(frame).toContain("1. Remove the feature worktree")
      expect(frame).toContain("git -C /repo worktree remove")
      expect(frame).toContain("2. Delete the local feat/close-ui branch")
      expect(frame).toContain("git -C /repo branch -d feat/close-ui")
      // The deferred rows carry no selection marker: only the push action has one.
      expect(frame).toContain("▸ ○ Push main")
      // Movement clamps inside the action list: the deferred rows can never
      // gain the selection marker or be activated.
      session.press("down")
      session.press("down")
      await session.renderOnce()
      expect(session.captureCharFrame()).toContain("▸ ○ Push main")
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })

  test("a remediation notice renders without becoming a selectable action", async () => {
    const session = await openClose()
    try {
      const view: CloseFollowUpsView = {
        actions: [
          { id: "worktree", label: "Remove worktree", detail: "/workspace/wt", status: "available" },
          { id: "branch", label: "Delete feat/close-ui", detail: "", status: "blocked" },
        ],
        notice: "main has no configured upstream — set one first: git -C /repo branch --set-upstream-to=<remote>/<branch> main",
      }
      const selection = session.instance.selectFollowUp(view)
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("main has no configured upstream")
      expect(frame).not.toContain("Push main")
      // The first action is worktree, not a fabricated push.
      expect(frame).toContain("Remove worktree  available")
      // The push shortcut finds no push action and stays inert; q leaves.
      session.press("p")
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })

  test("the PR fallback notice renders as guidance and is never a selectable action", async () => {
    const session = await openClose()
    try {
      const view: CloseFollowUpsView = {
        actions: [
          { id: "push", label: "Push main", detail: "Push to origin.", command: "git push origin main:main", status: "available" },
        ],
        notice: [
          "pull request #7 (https://github.com/acme/repo/pull/7) is open for feat/add-widget — after the push, if GitHub has not marked it merged, close it deliberately:",
          "gh pr close 7 --comment 'landed in main as abcd1234'",
        ].join("\n"),
      }
      const selection = session.instance.selectFollowUp(view)
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("pull request #7")
      expect(frame).toContain("https://github.com/acme/repo/pull/7")
      expect(frame).toContain("if GitHub has not marked it merged")
      expect(frame).toContain("gh pr close 7")
      // The notice is informational: only the push action is selectable.
      expect(frame).toContain("Push main  available")
      expect(frame).not.toContain("pr close  available")
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })

  test("completing the worktree removal unlocks branch deletion in the same view", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(outside)
      await session.renderOnce()
      session.instance.updateFollowUps({
        actions: [
          { id: "push", label: "Push main", detail: "", command: "git push origin main:main", status: "available" },
          { id: "worktree", label: "Remove worktree", detail: "/workspace/wt", status: "completed" },
          { id: "branch", label: "Delete feat/close-ui", detail: "Delete the local feature branch.", command: "git -C /repo branch -d feat/close-ui", status: "available" },
        ],
      })
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("Remove worktree  done")
      expect(frame).toContain("Delete feat/close-ui  available")
      // Selection retention is by id: the push row stays selected through the update.
      session.press("return")
      await expect(selection).resolves.toEqual({ type: "run", id: "push" })
    } finally {
      session.instance.destroy()
    }
  })

  test("q leaves every remaining cleanup action optional", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(outside)
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })
})
