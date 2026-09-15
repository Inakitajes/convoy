/**
 * Test-only lifecycle safety net (change `fix-opencode-server-lifecycle`).
 *
 * A test that abandons an in-flight helper — for example a real branch-name
 * proposal whose promise outlives the test file — leaves its owned
 * `opencode serve` child alive after `bun test` exits. Because the harness
 * points `CONVOY_HOME` at a throwaway directory (`test/env.ts`), the
 * production reconciliation under the developer's real `~/.convoy/processes/`
 * can never see that record once the run ends: the orphan would be
 * unattributable from then on.
 *
 * This teardown runs while the owner (this test process) is still alive, so it
 * can stop exactly the children this process recorded — never a PID it did not
 * spawn — and remove their records. It revalidates the recorded ownership and
 * child incarnation immediately before the signal, the same way the production
 * stop paths do.
 */

import { captureIdentity, defaultIdentityProbe, sameIdentity, type IdentityProbe } from "../src/process-identity"
import { createProcessRecordStore, processRecordsDir, type ProcessRecordStore } from "../src/process-records"
import { observedStopTarget, stopTarget, type StopOutcome, type StopPolicy } from "../src/process-stop"

export type StopOwnedTestServersDeps = {
  /** Store to sweep; defaults to the process-records dir under the test `CONVOY_HOME`. */
  store?: ProcessRecordStore
  probe?: IdentityProbe
  /** Injectable signal delivery, so the unit test never touches a real process. */
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  policy?: StopPolicy
  /** Diagnostics sink; defaults to silent because this runs during teardown. */
  onOutcome?: (recordId: string, outcome: StopOutcome) => void
}

/**
 * Stops every recorded `run`/`helper` child owned by this process and removes
 * the resolved records. Returns the ids it confirmed stopped. Records owned by
 * another process, already-gone children, and children whose incarnation no
 * longer matches the record are left in a safe state (matched records whose
 * child is gone are removed; everything else is untouched).
 */
export async function stopOwnedTestServers(
  dir: string = processRecordsDir(),
  deps: StopOwnedTestServersDeps = {},
): Promise<string[]> {
  const store = deps.store ?? createProcessRecordStore(dir)
  const records = await store.list().catch(() => [])
  if (records.length === 0) return []

  const probe = deps.probe ?? defaultIdentityProbe()
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig))
  const self = await captureIdentity(process.pid, probe).catch(() => undefined)
  // Without our own identity we cannot prove ownership; leave evidence intact
  // rather than signal a child we cannot attribute to this process.
  if (!self) return []

  const stopped: string[] = []
  for (const record of records) {
    const child = record.child
    if (!record.owner || !child) continue
    if (!sameIdentity(record.owner, self)) continue

    const observed = await probe.observe(child.pid)
    if (observed.status === "gone") {
      await store.remove(record.id)
      continue
    }
    if (observed.status !== "alive" || !sameIdentity(child, observed.identity)) continue

    const verify = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const recheck = await probe.observe(child.pid)
      if (recheck.status === "gone") return { ok: true }
      if (recheck.status !== "alive") return { ok: false, reason: `child identity became ${recheck.status}` }
      return sameIdentity(child, recheck.identity)
        ? { ok: true }
        : { ok: false, reason: "child incarnation changed before escalation" }
    }

    const outcome = await stopTarget(
      observedStopTarget({
        pid: child.pid,
        observe: async () => {
          const now = await probe.observe(child.pid)
          return now.status === "mismatch" ? "unknown" : now.status
        },
        signal: (sig) => signal(child.pid, sig),
        verify,
      }),
      deps.policy,
    )
    deps.onOutcome?.(record.id, outcome)
    if (outcome.status === "stopped") {
      await store.remove(record.id)
      stopped.push(record.id)
    }
  }
  return stopped
}
