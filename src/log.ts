import { redactSecrets } from "./runners/redaction"

const useColor = process.stderr.isTTY && !process.env.NO_COLOR
let muted = false

function color(code: string, value: string) {
  if (!useColor) return value
  return `\u001b[${code}m${value}\u001b[0m`
}

// Every log line is redacted: registered runtime secrets (bridge tokens, a
// managed server's boot password) and recognizable credential shapes never reach
// stderr even when a fault message happens to embed one.
function safe(message: string): string {
  return redactSecrets(message)
}

export const log = {
  mute(value: boolean) {
    muted = value
  },
  info(message: string) {
    if (muted) return
    console.error(color("36", `-> ${safe(message)}`))
  },
  warn(message: string) {
    if (muted) return
    console.error(color("33", `! ${safe(message)}`))
  },
  // Real faults surface even while the TUI has muted ordinary logs; staying
  // silent here is what hides production bugs.
  error(message: string) {
    console.error(color("31;1", `✗ ${safe(message)}`))
  },
  section(message: string) {
    if (muted) return
    console.error("")
    console.error(color("32;1", safe(message)))
  },
}
