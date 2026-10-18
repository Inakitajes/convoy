/**
 * Shell inspection as reading (change `add-codex-runner`).
 *
 * Codex has no file-read tool: an agent reads the checkout through its shell
 * (`cat`, `sed -n`, `rg`, `git diff`…). Convoy treats a command that only
 * inspects as the reads it performs, so a read-only or verifying phase can
 * read, and a writable phase is not asked about every `cat`, while each path
 * still passes the read policy — the checkout, the run directory and the
 * attachments only, never a protected root. Anything else (a write, a
 * redirection, a substitution, an unknown program) stays an execution.
 */

import { commandSegments, commandWords, unwrapShellScript } from "../policy"

/** Programs that only read what they are pointed at. */
const readers = new Set(["cat", "head", "tail", "ls", "wc", "rg", "grep", "file", "stat", "pwd", "nl", "du"])
/** Programs whose reach is a whole tree below each path (`ls` and `grep` only when recursive). */
const treeReaders = new Set(["rg", "find", "du"])
const recursiveFlag = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/
/** Options that make a reader write a file or run another program (`git log --output`, `rg --pre`). */
const unsafeOption = /^--(output|pre|pre-glob)(=|$)/
const gitReaders = new Set(["log", "diff", "show", "status", "branch", "rev-parse", "ls-files", "blame", "grep"])
const findWriters = /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/
/** Options whose next word is a value, not a path. */
const valueFlags = new Set(["-e", "-f", "--regexp", "-g", "--glob", "-t", "--type", "-m", "--max-count", "-A", "-B", "-C", "-n", "-c", "--name", "-name", "-iname", "-type", "-maxdepth", "-mindepth", "--format", "--pretty", "-L"])

export type InspectionReads = {
  /** Path-like words the command reads, in the order given; empty means the working directory. */
  paths: string[]
  /** True when a path is read recursively (a search or listing below it). */
  tree: boolean
}

function pathWords(words: readonly string[], skipFirst: number): string[] {
  const out: string[] = []
  let skipNext = false
  let positional = 0
  for (const word of words.slice(skipFirst)) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (word.startsWith("-")) {
      if (valueFlags.has(word)) skipNext = true
      continue
    }
    positional++
    if (word === "/" || word.startsWith("/") || word.startsWith("~") || word.startsWith("$") || word.startsWith(".") || word.includes("/")) out.push(word)
    else if (positional > 0 && /^[\w.@+-]+$/.test(word) && !word.includes("*")) out.push(word)
  }
  return out
}

/**
 * The reads an inspection command performs, or undefined when the command
 * does anything but read (it is then judged as an execution). A search's
 * first positional word is its pattern, not a path.
 */
export function inspectionReads(command: string): InspectionReads | undefined {
  const script = unwrapShellScript(command)
  if (!commandSegments(script)) return undefined
  const commands = commandWords(script)
  if (commands.length === 0) return undefined
  const paths: string[] = []
  let tree = false
  for (const words of commands) {
    if (words.some((word) => unsafeOption.test(word))) return undefined
    const program = words[0]!.split("/").at(-1)!
    if (program === "git") {
      const sub = words.slice(1).find((word) => !word.startsWith("-"))
      if (!sub || !gitReaders.has(sub)) return undefined
      tree = true
      continue
    }
    if (program === "sed") {
      // Only `sed -n '<range>p' <file>`: a print, never an edit in place.
      if (!words.includes("-n") || words.some((word) => /^-i|^--in-place/.test(word))) return undefined
      const script = words.find((word, index) => index > 0 && !word.startsWith("-"))
      if (!script || !/^[\d,$;p\s]+$/.test(script)) return undefined
      paths.push(...pathWords(words.slice(words.indexOf(script) + 1), 0))
      continue
    }
    if (program === "find") {
      if (words.some((word) => findWriters.test(word))) return undefined
      tree = true
      paths.push(...pathWords(words, 1).filter((word) => !word.includes("*")))
      continue
    }
    if (!readers.has(program)) return undefined
    if (treeReaders.has(program) || ((program === "ls" || program === "grep") && words.some((word) => recursiveFlag.test(word)))) tree = true
    // A search's first positional word is its pattern.
    const skip = program === "rg" || program === "grep" ? patternIndex(words) : 1
    paths.push(...pathWords(words, skip))
  }
  return { paths, tree }
}

function patternIndex(words: readonly string[]): number {
  if (words.some((word) => word === "-e" || word === "--regexp" || word === "-f" || word === "--files")) return 1
  let skipNext = false
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!
    if (skipNext) {
      skipNext = false
      continue
    }
    if (word.startsWith("-")) {
      if (valueFlags.has(word)) skipNext = true
      continue
    }
    return index + 1
  }
  return words.length
}
