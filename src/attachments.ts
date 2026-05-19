import { stat } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { FilePartInput } from "@opencode-ai/sdk/v2"

type MissingMode = "skip" | "error"

export async function fileParts(paths: string[], baseDir: string, missing: MissingMode): Promise<FilePartInput[]> {
  const out: FilePartInput[] = []
  for (const input of paths) {
    const path = isAbsolute(input) ? input : resolve(baseDir, input)
    let info
    try {
      info = await stat(path)
    } catch {
      if (missing === "error") throw new Error(`file not found for --file: ${input}`)
      continue
    }

    out.push({
      type: "file",
      url: pathToFileURL(path).href,
      filename: basename(path),
      mime: info.isDirectory() ? "application/x-directory" : guessMime(path),
    })
  }
  return out
}

function guessMime(path: string) {
  return Bun.file(path).type || "text/plain"
}
