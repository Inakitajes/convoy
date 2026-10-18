import { mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"

import { log } from "./log"

/** Tees a CLI runner's raw NDJSON stream to an owner-only file; a write failure warns once and never fails the attempt. */
export class RawStreamLog {
  private file: Awaited<ReturnType<typeof open>> | undefined
  private failed = false

  constructor(private readonly path: string, private readonly phaseName: string) {}

  async append(line: string) {
    if (this.failed) return
    try {
      const file = await this.openFile()
      await file.write(`${line}\n`)
    } catch (error) {
      await this.fail(error)
    }
  }

  async close() {
    try {
      await this.file?.close()
      this.file = undefined
    } catch (error) {
      await this.fail(error)
    }
  }

  private async openFile() {
    if (this.file) return this.file
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    this.file = await open(this.path, "w", 0o600)
    await this.file.chmod(0o600)
    return this.file
  }

  private async fail(error: unknown) {
    if (this.failed) return
    this.failed = true
    await this.file?.close().catch(() => undefined)
    this.file = undefined
    log.warn(`[${this.phaseName}] couldn't write the runner's raw stream log: ${error instanceof Error ? error.message : String(error)}`)
  }
}
