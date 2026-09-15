/**
 * Standalone smoke test for the process-identity probe (change
 * `fix-opencode-server-lifecycle`, design D5/D7).
 *
 *   bun run scripts/identity-smoke.ts
 *   # or, to exercise the *compiled-binary* FFI path (macOS libproc via
 *   # bun:ffi, Linux /proc) rather than the dev runtime:
 *   bun build scripts/identity-smoke.ts --compile --outfile /tmp/identity-smoke && /tmp/identity-smoke
 *
 * The managed-server tests prove the probe works inside the test runtime; this
 * proves the same adapter still loads and answers when Convoy is bundled into a
 * standalone executable, which is how releases ship.
 *
 * It spawns only a throwaway `sleep` child — never OpenCode — and touches no
 * user configuration or `CONVOY_HOME` state. Exit code 0 means every probe
 * behaved; 1 means at least one did not.
 */
import { spawn } from "node:child_process"

import { captureIdentity, defaultIdentityProbe, identityMismatchReason, sameIdentity } from "../src/process-identity"

const failures: string[] = []
const check = (ok: boolean, message: string): void => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${message}\n`)
  if (!ok) failures.push(message)
}

const probe = defaultIdentityProbe()
process.stdout.write(`platform: ${process.platform}\n`)

// 1. The probe must answer for a process that certainly exists: this one.
const self = await probe.observe(process.pid)
check(self.status === "alive", `self probe reports alive (got ${self.status})`)
if (self.status === "alive") {
  check(self.identity.pid === process.pid, "self identity names this pid")
  check(self.identity.birth.includes(":"), `self birth carries a boot discriminator (${self.identity.birth})`)
  check(self.identity.executable.length > 0, `self executable observed (${self.identity.executable})`)
} else if (self.status !== "gone") {
  process.stderr.write(`  reason: ${self.reason}\n`)
}

// 2. A real child fixture, the same shape a managed server has.
const child = spawn("sleep", ["30"], { stdio: "ignore" })
const childPid = child.pid ?? 0
check(childPid > 0, "spawned a fixture child")
const captured = childPid > 0 ? await captureIdentity(childPid, probe) : undefined
check(Boolean(captured), "captured the fixture child's identity")
if (captured) {
  const observed = await probe.observe(captured.pid)
  check(
    observed.status === "alive" && sameIdentity(captured, observed.identity),
    "fixture identity re-observes identically (pid + birth + uid)",
  )

  // 3. A reboot changes the boot discriminator, so the old incarnation can
  //    never match — the reason recovery must refuse to signal it.
  const startTicks = captured.birth.slice(captured.birth.lastIndexOf(":") + 1)
  const afterReboot = { ...captured, birth: `rebooted-boot:${startTicks}` }
  check(!sameIdentity(captured, afterReboot), "a reboot never matches the recorded incarnation")
  check(Boolean(identityMismatchReason(captured, afterReboot)), "the reboot mismatch explains itself")
}

// Teardown: stop the fixture and observe it gone. Never leave it behind.
if (childPid > 0) {
  child.kill("SIGTERM")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const gone = await probe.observe(childPid)
  check(gone.status === "gone", `fixture child is gone after teardown (got ${gone.status})`)
}

process.stdout.write(failures.length === 0 ? "\nidentity smoke: PASS\n" : `\nidentity smoke: FAIL (${failures.length})\n`)
process.exit(failures.length === 0 ? 0 : 1)
