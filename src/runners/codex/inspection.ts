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
 *
 * The reading fails closed. Every word that is not an option, a known
 * non-path option value, or a search pattern is judged as a path, so an
 * option the classifier does not know can only make it stricter. A word whose
 * text the shell decides (a variable, a brace, `~user`) or a command run in a
 * changed environment is not inspection, and a glob is judged as the tree
 * below its fixed prefix.
 */

import { commandSegments, commandShellWords, staticGlobPrefix, unwrapShellScript, type ShellWord } from "../policy"

/** One read: a path (undefined means the working directory) and whether the tree below it is reached. */
export type InspectionRead = { path?: string; tree: boolean }

/**
 * What an option's value is. A `number` value is taken only when the next word
 * looks like one, so an option that is a flag in another implementation never
 * swallows a path.
 */
type ValueKind = "number" | "text" | "pattern" | "path"

type ParsedOptions = {
  /** Every option given, a short cluster split into its letters (`-rn` is `-r` and `-n`). */
  options: Set<string>
  /** Option values by option name. */
  values: Map<string, string>
  positionals: ShellWord[]
  /** Words judged as reads besides the positionals: path values and globbed values. */
  reads: InspectionRead[]
}

type Reader = {
  options?: Readonly<Record<string, ValueKind>>
  /** The first positional word is the search pattern, unless an option gave one. */
  pattern?: boolean
  /** Whether each path is read as a tree. */
  tree?: boolean | ((parsed: ParsedOptions) => boolean)
  /** Options that make the program write, run another program, follow links out of the tree, or read a list of paths from a file. */
  unsafe?: readonly string[]
}

const number = "number" as const
const text = "text" as const

const readers: Readonly<Record<string, Reader>> = {
  cat: {},
  head: { options: { "-n": number, "-c": number, "--lines": number, "--bytes": number } },
  tail: { options: { "-n": number, "-c": number, "--lines": number, "--bytes": number } },
  wc: { unsafe: ["--files0-from"] },
  nl: { options: Object.fromEntries([..."bdfhilnsvw"].map((letter) => [`-${letter}`, text])) },
  ls: { tree: (parsed) => parsed.options.has("-R") || parsed.options.has("--recursive") },
  file: { options: { "-m": "path", "--magic-file": "path" }, unsafe: ["-f", "--files-from"] },
  stat: {},
  pwd: {},
  du: { options: { "-d": number, "-B": number, "-t": number, "--max-depth": number, "-X": "path", "--exclude-from": "path" }, tree: true, unsafe: ["--files0-from"] },
  grep: {
    options: {
      "-A": number, "-B": number, "-C": number, "-m": number, "--max-count": number, "--context": number, "--after-context": number, "--before-context": number,
      "-d": text, "-D": text, "--directories": text, "--devices": text, "--include": text, "--exclude": text, "--exclude-dir": text, "--label": text,
      "-e": "pattern", "--regexp": "pattern", "-f": "path", "--file": "path", "--exclude-from": "path",
    },
    pattern: true,
    tree: (parsed) => ["-r", "--recursive"].some((option) => parsed.options.has(option)) || parsed.values.get("-d") === "recurse" || parsed.values.get("--directories") === "recurse",
    unsafe: ["-R", "--dereference-recursive"],
  },
  rg: {
    options: {
      "-A": number, "-B": number, "-C": number, "-M": number, "-d": number, "-j": number, "-m": number,
      "--after-context": number, "--before-context": number, "--context": number, "--max-columns": number, "--max-count": number, "--max-depth": number, "--maxdepth": number, "--threads": number,
      "-E": text, "-g": text, "-r": text, "-t": text, "-T": text,
      "--encoding": text, "--glob": text, "--iglob": text, "--replace": text, "--type": text, "--type-not": text, "--type-add": text, "--type-clear": text, "--sort": text, "--sortr": text,
      "--color": text, "--colors": text, "--engine": text, "--max-filesize": text, "--context-separator": text, "--path-separator": text, "--field-match-separator": text, "--field-context-separator": text,
      "-e": "pattern", "--regexp": "pattern", "-f": "path", "--file": "path", "--ignore-file": "path",
    },
    pattern: true,
    tree: true,
    unsafe: ["--pre", "--pre-glob", "--hostname-bin", "-L", "--follow"],
  },
}

/** Options no reader may be given: they write a file or run another program (`git log --output`, `rg --pre`). */
const unsafeOption = /^--(output|pre|pre-glob)(=|$)/
const findUnsafe = /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls|files0-from|follow|L)$/
const findFileTests = new Set(["-newer", "-anewer", "-cnewer", "-samefile"])
const sedOptions = new Set(["-n", "-E", "-r", "-s", "-u", "-z", "--quiet", "--silent", "--posix", "--regexp-extended", "--separate", "--unbuffered", "--null-data"])
const numeric = /^[+-]?\d+[a-zA-Z]*$/

/** Git subcommands that only read, and the options that make one write a file, read outside the repository, or run a program. */
const gitReaders = new Set(["log", "diff", "show", "status", "branch", "rev-parse", "ls-files", "blame", "grep"])
const gitUnsafe = /^--(output|ext-diff|no-index|open-files-in-pager)(=|$)/
const gitGrep: Reader = {
  options: { "-A": number, "-B": number, "-C": number, "-m": number, "--max-count": number, "--max-depth": number, "--threads": number, "-e": "pattern", "-f": "path" },
  pattern: true,
  unsafe: ["-O"],
}
/** `git branch` options that list; any other creates, renames, copies or deletes a branch. */
const branchListing = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "--verbose", "-i", "--ignore-case", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--color", "--no-color", "--abbrev", "--no-abbrev"])
/** Options under which `git branch` takes a pattern or a commit, not a new branch's name. */
const branchPatterns = ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]

/**
 * The reads an inspection command performs, or undefined when the command
 * does anything but read (it is then judged as an execution).
 */
export function inspectionReads(command: string): InspectionRead[] | undefined {
  const script = unwrapShellScript(command)
  if (!commandSegments(script)) return undefined
  const commands = commandShellWords(script)
  if (commands.length === 0) return undefined
  const reads: InspectionRead[] = []
  for (const { words, prefixed } of commands) {
    if (prefixed || words[0]!.glob || words.some((word) => word.opaque || unsafeOption.test(word.text))) return undefined
    const program = words[0]!.text.split("/").at(-1)!
    const found = program === "git" ? gitReads(words) : program === "sed" ? sedReads(words) : program === "find" ? findReads(words) : readerReads(words, readers[program])
    if (!found) return undefined
    reads.push(...found)
  }
  return reads
}

function readerReads(words: readonly ShellWord[], reader: Reader | undefined, base?: string): InspectionRead[] | undefined {
  if (!reader) return undefined
  const parsed = parseOptions(words.slice(1), reader, base)
  if (!parsed) return undefined
  const tree = typeof reader.tree === "function" ? reader.tree(parsed) : reader.tree === true
  let positionals = parsed.positionals
  const explicitPattern = [...parsed.options].some((option) => reader.options?.[option] === "pattern") || parsed.options.has("--files") || parsed.options.has("--type-list")
  if (reader.pattern && !explicitPattern && positionals.length > 0) {
    // The pattern is not a path, but a glob in it can still expand into paths.
    if (positionals[0]!.glob) parsed.reads.push(pathRead(positionals[0]!, true, base))
    positionals = positionals.slice(1)
  }
  const reads = [...parsed.reads, ...positionals.map((word) => pathRead(word, tree, base))]
  return reads.length > 0 ? reads : [{ ...(base !== undefined ? { path: base } : {}), tree }]
}

/** Splits a reader's arguments into options, their values and positionals; undefined when an unsafe option is given. */
function parseOptions(args: readonly ShellWord[], reader: Reader, base: string | undefined): ParsedOptions | undefined {
  const parsed: ParsedOptions = { options: new Set(), values: new Map(), positionals: [], reads: [] }
  const kinds = reader.options ?? {}
  const take = (name: string, value: ShellWord | undefined) => {
    if (!value) return
    parsed.values.set(name, value.text)
    if (kinds[name] === "path" || value.glob) parsed.reads.push(pathRead(value, value.glob, base))
  }
  const next = (index: number, kind: ValueKind) => {
    const value = args[index + 1]
    return value && (kind !== "number" || numeric.test(value.text)) ? value : undefined
  }
  let endOfOptions = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (endOfOptions || !word.text.startsWith("-") || word.text === "-") {
      if (word.text !== "-") parsed.positionals.push(word)
      continue
    }
    if (word.text === "--") {
      endOfOptions = true
      continue
    }
    if (word.text.startsWith("--")) {
      const equals = word.text.indexOf("=")
      const name = equals === -1 ? word.text : word.text.slice(0, equals)
      parsed.options.add(name)
      if (reader.unsafe?.includes(name)) return undefined
      const inline = equals === -1 ? undefined : { ...word, text: word.text.slice(equals + 1) }
      const kind = kinds[name]
      if (!kind) {
        // An option the classifier does not know: its inline value may be a path.
        if (inline) parsed.reads.push(pathRead(inline, false, base))
        continue
      }
      const value = inline ?? next(index, kind)
      if (!inline && value) index++
      take(name, value)
      continue
    }
    for (let letter = 1; letter < word.text.length; letter++) {
      const name = `-${word.text[letter]}`
      parsed.options.add(name)
      if (reader.unsafe?.includes(name)) return undefined
      const kind = kinds[name]
      if (!kind) continue
      if (letter + 1 < word.text.length) {
        take(name, { ...word, text: word.text.slice(letter + 1) })
      } else {
        const value = next(index, kind)
        if (value) index++
        take(name, value)
      }
      break
    }
  }
  return parsed
}

/**
 * A word judged as a path, under `base` when relative. A glob reaches the tree
 * below its fixed prefix, and the parent too when a segment could match `..`
 * (`.*` in some shells).
 */
function pathRead(word: ShellWord, tree: boolean, base?: string): InspectionRead {
  const path = base !== undefined && !/^(\/|~|\$HOME|\$\{HOME\})/.test(word.text) ? `${base}/${word.text}` : word.text
  if (!word.glob) return { path, tree }
  const prefix = staticGlobPrefix(path)
  const dotGlob = path.split("/").some((segment) => segment.startsWith(".") && /[*?[]/.test(segment))
  return { path: dotGlob ? `${prefix}/..` : prefix, tree: true }
}

/** `sed -n '<range>p' <file>…`: a print, never an edit in place or a script file. */
function sedReads(words: readonly ShellWord[]): InspectionRead[] | undefined {
  const options = words.slice(1).filter((word) => word.text.startsWith("-") && word.text !== "-")
  const names = options.flatMap((word) => (word.text.startsWith("--") ? [word.text] : [...word.text.slice(1)].map((letter) => `-${letter}`)))
  if (!names.every((name) => sedOptions.has(name)) || !names.some((name) => ["-n", "--quiet", "--silent"].includes(name))) return undefined
  const [script, ...files] = words.slice(1).filter((word) => !options.includes(word))
  if (!script || !/^[\d,$;p\s]+$/.test(script.text)) return undefined
  const reads = files.filter((word) => word.text !== "-").map((word) => pathRead(word, false))
  return reads.length > 0 ? reads : [{ tree: false }]
}

/** `find <path>… <expression>`: the paths come first; the expression may not write, run, or follow links. */
function findReads(words: readonly ShellWord[]): InspectionRead[] | undefined {
  const reads: InspectionRead[] = []
  let index = 1
  while (["-H", "-P", "-E", "-X", "-s", "-x", "-d"].includes(words[index]?.text ?? "")) index++
  for (; index < words.length; index++) {
    const word = words[index]!
    if (word.text === "-f") {
      const path = words[++index]
      if (path) reads.push(pathRead(path, true))
      continue
    }
    if (word.text.startsWith("-") || word.text === "(" || word.text === "!") break
    reads.push(pathRead(word, true))
  }
  for (; index < words.length; index++) {
    const word = words[index]!
    if (findUnsafe.test(word.text)) return undefined
    if (findFileTests.has(word.text) && words[index + 1]) reads.push(pathRead(words[++index]!, false))
    else if (word.glob) reads.push(pathRead(word, true))
  }
  return reads.length > 0 ? reads : [{ tree: true }]
}

/**
 * A git subcommand that only reads. Every path or revision word is judged as a
 * path under the checkout, so nothing outside it is read (`git diff` reads
 * files outside the repository as `--no-index` would), and `git branch` only
 * lists.
 */
function gitReads(words: readonly ShellWord[]): InspectionRead[] | undefined {
  let index = 1
  let base: string | undefined
  for (; index < words.length; index++) {
    const option = words[index]!.text
    if (option === "--no-pager" || option === "-P" || option === "--no-optional-locks") continue
    if (option === "-C" && words[index + 1] && !words[index + 1]!.glob) {
      const dir = words[++index]!.text
      base = base !== undefined && !/^(\/|~)/.test(dir) ? `${base}/${dir}` : dir
      continue
    }
    // Any other global option (`-c`, `--git-dir`, `--exec-path`…) can change what git runs or reads.
    if (option.startsWith("-")) return undefined
    break
  }
  const sub = words[index]
  if (!sub || !gitReaders.has(sub.text)) return undefined
  const args = words.slice(index + 1)
  if (args.some((word) => gitUnsafe.test(word.text))) return undefined
  if (sub.text === "branch") {
    const options = args
      .filter((word) => word.text.startsWith("-"))
      .flatMap((word) => (word.text.startsWith("--") ? [word.text.split("=")[0]!] : [...word.text.slice(1)].map((letter) => `-${letter}`)))
    if (!options.every((option) => branchListing.has(option))) return undefined
    // A name without a listing option creates a branch.
    if (args.some((word) => !word.text.startsWith("-")) && !options.some((option) => branchPatterns.includes(option))) return undefined
    return [{ ...(base !== undefined ? { path: base } : {}), tree: true }]
  }
  return readerReads([sub, ...args], sub.text === "grep" ? gitGrep : { tree: true }, base)?.map((read) => ({ ...read, tree: true }))
}
