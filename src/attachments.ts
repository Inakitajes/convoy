import { stat } from "node:fs/promises"
import { basename, extname, isAbsolute, resolve } from "node:path"
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
  const mime = Bun.file(path).type
  if (isTextAttachment(path, mime)) return "text/plain"
  return mime || "text/plain"
}

const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".diff",
  ".go",
  ".gradle",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".lock",
  ".md",
  ".patch",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
])

const textFilenames = new Set(["dockerfile", "makefile", "readme", "license"])
const textMimes = new Set(["application/json", "application/javascript", "application/xml", "application/x-ndjson"])

function isTextAttachment(path: string, mime: string) {
  const baseMime = mime.split(";")[0]?.toLowerCase() ?? ""
  if (baseMime.startsWith("text/")) return true
  if (textMimes.has(baseMime)) return true
  if (textExtensions.has(extname(path).toLowerCase())) return true
  return textFilenames.has(basename(path).toLowerCase())
}
