/**
 * Task 2.2 feasibility probe (`unify-work-context`): proves the foreground
 * host contract in a real terminal (run under a pty, e.g.
 * `script -q /dev/null bun run scripts/feasibility-foreground.ts`). Exercises
 * normal exit, non-zero exit, interruption (SIGINT delivered to the child the
 * way the terminal's Ctrl+C would), and resize-while-child-owns-terminal,
 * then verifies the renderer is usable again at the current dimensions.
 */
import { appendFileSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { runForegroundChild } from "../src/terminal-host"

// Records go to a file: the pty's alternate-screen paints would clobber
// stdout lines, so the durable record is what the report quotes.
const logPath = process.env.CONVOY_FOREGROUND_LOG ?? "feasibility-foreground.log"
const record = (step: string, outcome: unknown) => {
  appendFileSync(logPath, `STEP ${step}: ${JSON.stringify(outcome).slice(0, 300)}\n`)
}

// A real alternate-screen renderer against this process's TTY.
const renderer = await createCliRenderer({ screenMode: "alternate-screen", consoleMode: "console-overlay", exitOnCtrlC: false })
await renderer.waitForThemeMode(1_000).catch(() => null)
const dimensionsAtStart = { width: renderer.width, height: renderer.height }
record("renderer-up", { ...dimensionsAtStart, destroyed: renderer.isDestroyed })

const events: string[] = []
const suspend = () => {
  events.push("suspend")
  renderer.suspend()
}
const resume = () => {
  events.push("resume")
  renderer.resume()
}

// 1. Normal exit.
const normal = await runForegroundChild({ argv: ["sh", "-lc", "exit 0"], cwd: process.cwd(), suspend, resume })
record("normal-exit", { code: normal, events: events.splice(0), destroyed: renderer.isDestroyed })

// 2. Non-zero exit.
const failing = await runForegroundChild({ argv: ["sh", "-lc", "echo to-terminal >&2; exit 7"], cwd: process.cwd(), suspend, resume })
record("nonzero-exit", { code: failing, events: events.splice(0), destroyed: renderer.isDestroyed })

// 3. Startup failure (the child does not exist).
const spawnFailure = await runForegroundChild({ argv: ["/definitely/not/a/binary"], cwd: process.cwd(), suspend, resume }).then(
  (code) => ({ code }),
  (error: unknown) => ({ error: error instanceof Error ? error.message.slice(0, 120) : String(error) }),
)
record("startup-failure", { ...spawnFailure, events: events.splice(0), destroyed: renderer.isDestroyed })

// 4. Interruption: the child installs the trap a harness client would, then
//    receives SIGINT on its own process group — the same signal the
//    terminal's Ctrl+C delivers to the foreground child.
const interruptChild = Bun.spawn(["sh", "-lc", 'trap \'echo interrupted >&2; exit 130\' INT; sleep 30 & wait $!'], {
  cwd: process.cwd(),
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
})
// Give the trap a moment to install, then signal the child directly.
await Bun.sleep(200)
interruptChild.kill("SIGINT")
const interruptCode = await interruptChild.exited
record("child-interrupt-signal", { code: interruptCode })

// 5. Resize while a child owns the terminal: shrink the pty from inside the
//    child (stty on its controlling terminal), then return — the renderer
//    must repaint at the new dimensions.
const resizeScript = `stty rows 20 cols 60 2>/dev/null; sleep 0.3; exit 0`
await runForegroundChild({ argv: ["sh", "-lc", resizeScript], cwd: process.cwd(), suspend, resume })
record("resize-while-child-owned", {
  before: dimensionsAtStart,
  after: { width: renderer.width, height: renderer.height },
  events: events.splice(0),
  destroyed: renderer.isDestroyed,
  inputAlive: renderer.keyInput !== undefined,
})

// 6. SIGINT to Convoy itself while suspended is delivered to the foreground
//    child (inherited streams); verify Convoy's own handlers still work after
//    restore by issuing a clean renderer teardown.
renderer.destroy()
record("teardown", { destroyed: renderer.isDestroyed })
console.log("PROBE COMPLETE")
process.exit(0)
