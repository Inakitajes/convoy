import { stat } from "node:fs/promises"
import { join } from "node:path"

export const projectContextFiles = [".convoy/rules.md", "AGENTS.md", "CLAUDE.md"] as const

export type ProjectContextFile = (typeof projectContextFiles)[number]

export async function discoverProjectContextFiles(targetDir: string): Promise<ProjectContextFile[]> {
  const found: ProjectContextFile[] = []
  for (const file of projectContextFiles) {
    if (await isFile(join(targetDir, file))) found.push(file)
  }
  return found
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
