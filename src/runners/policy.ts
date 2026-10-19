/**
 * Runner-neutral action policy evaluation (change `runner-parity-opencode-v2`,
 * task 6.1).
 *
 * Core decides whether a normalized action is read, write, execute, delegate, or
 * read-only-forbidden; adapters map their native tools to that intent. This keeps
 * one policy for both runners instead of two harness-specific permission systems,
 * while preserving hard denials, read-only/verification restrictions, the
 * mandatory advisor checkpoint, and the interactive/auto/smart approval modes.
 *
 * Enforcement (intercepting the request in the harness) is a separate, adapter
 * concern; this module only decides.
 */

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { ApprovalMode, ExecutionMode } from "./contracts"

/** Environment variable carrying an attempt's reviewed policy to out-of-process enforcement. */
export const runnerPolicyEnv = "CONVOY_RUNNER_POLICY"

export type ActionIntent = "read" | "write" | "execute" | "delegate" | "network" | "other"

export type ActionRequest = {
  /** Native tool name, retained for diagnostics only. */
  tool: string
  intent: ActionIntent
  /** The resource the action targets (a path or a command), when known. */
  resource?: string
  /**
   * `tree` when the action reads everything below its path (a search), so an
   * ancestor of a protected root reaches it too; a single file otherwise.
   */
  scope?: "file" | "tree"
  /** The directory a relative resource is resolved against (the harness's cwd). */
  cwd?: string
}

export type PolicyDecision = {
  effect: "allow" | "deny" | "ask"
  reason: string
}

export type HardDenyRule = { intent?: ActionIntent; resource?: string }

export type PolicyConfig = {
  mode: ExecutionMode
  approvals: ApprovalMode
  /** Actions never allowed in any mode (hard denials). */
  hardDeny?: readonly HardDenyRule[]
  /** Resource patterns an execution may run under read-only/verify (e.g. tests). */
  verifyAllow?: readonly string[]
  /** Block writes until the advisor checkpoint is satisfied (D8). */
  requireAdvisorBeforeWrite?: boolean
  /**
   * Ordered shell-command rules with OpenCode's semantics: `*` globs, the last
   * matching rule wins. `deny` is a hard denial in every mode, verification
   * runs only `allow` commands, and `ask` follows the approval mode. Every
   * segment of a chained command must pass on its own.
   */
  commands?: Readonly<Record<string, CommandEffect>>
  /** Absolute roots a write may target; a write elsewhere is denied. */
  writeRoots?: readonly string[]
  /** Absolute roots no action may touch (secrets), whatever the mode. */
  denyRoots?: readonly string[]
  /**
   * Absolute roots a read may target besides `writeRoots` (attachments). When
   * set, a read anywhere else is denied, as OpenCode's `external_directory`.
   */
  readRoots?: readonly string[]
  /** The step's checkout: relative resources resolve against it when the request names no cwd. */
  cwd?: string
}

export type CommandEffect = "allow" | "deny" | "ask"

export type PolicyState = {
  /** True once the mandatory advisor consultation has happened. */
  advisorSatisfied?: boolean
}

const readOnlyDenied: ReadonlySet<ActionIntent> = new Set(["write", "execute", "delegate", "network"])
const verifyDenied: ReadonlySet<ActionIntent> = new Set(["write", "delegate", "network"])
const askWorthy: ReadonlySet<ActionIntent> = new Set(["write", "execute", "delegate", "network"])

function matchesRule(request: ActionRequest, rule: HardDenyRule): boolean {
  if (rule.intent !== undefined && rule.intent !== request.intent) return false
  if (rule.resource !== undefined) {
    if (request.resource === undefined) return false
    if (!request.resource.includes(rule.resource)) return false
  }
  return true
}

function isVerifyAllowed(request: ActionRequest, patterns: readonly string[]): boolean {
  if (request.resource === undefined) return false
  return patterns.some((pattern) => request.resource!.includes(pattern))
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")
  return new RegExp(`^${escaped}$`)
}

/** The effect of the last rule matching one simple command, as OpenCode evaluates it. */
export function commandEffect(command: string, rules: Readonly<Record<string, CommandEffect>>): CommandEffect | undefined {
  let effect: CommandEffect | undefined
  for (const [pattern, value] of Object.entries(rules)) {
    if (globToRegExp(pattern).test(command)) effect = value
  }
  return effect
}

// Redirections that cannot write a file: fd duplication and the null device.
const harmlessRedirect = /\d*>&\d+|\d*>>?\s*\/dev\/null/g

/**
 * Splits a shell command into its simple commands. Returns undefined when the
 * command writes through a redirection or substitutes a command, which no
 * prefix rule can vouch for.
 */
export function commandSegments(command: string): string[] | undefined {
  const cleaned = command.replace(harmlessRedirect, " ")
  if (/[<>`]|\$\(/.test(cleaned)) return undefined
  return cleaned
    .split(/&&|\|\||[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

const effectRank: Record<CommandEffect, number> = { allow: 0, ask: 1, deny: 2 }

// Words a shell runs before the real command, or that only introduce one.
const reservedWords = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "{", "}"])
const commandWrappers = new Set(["command", "builtin", "exec", "nohup", "env", "time", "nice", "stdbuf", "caffeinate"])
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The text of `$( … )`, `<( … )`, `>( … )`, and backtick substitutions, each
 * a command the shell runs; nested substitutions surface in the recursion.
 */
function substitutions(command: string): string[] {
  const found: string[] = []
  for (let i = 0; i < command.length; i++) {
    const opener = command[i] === "`" ? "`" : /[$<>]/.test(command[i]!) && command[i + 1] === "(" ? "(" : undefined
    if (!opener) continue
    if (opener === "`") {
      const end = command.indexOf("`", i + 1)
      found.push(command.slice(i + 1, end === -1 ? undefined : end))
      i = end === -1 ? command.length : end
      continue
    }
    let depth = 0
    let j = i + 1
    for (; j < command.length; j++) {
      if (command[j] === "(") depth++
      else if (command[j] === ")" && --depth === 0) break
    }
    found.push(command.slice(i + 2, j))
    i = j
  }
  return found
}

/**
 * One word of a simple command, quoting removed, with what the shell would
 * still do to it: `glob` when it holds an unquoted `*`, `?` or `[`, and
 * `opaque` when its final text is not knowable from the line — a variable
 * (other than a leading `$HOME`), a brace expansion, or `~user`.
 */
export type ShellWord = { text: string; glob: boolean; opaque: boolean }

const leadingHome = /^(\$HOME|\$\{HOME\})(\/|$)/

/**
 * Splits a command into simple commands as the shell would — on unquoted
 * separators and grouping characters — then removes quoting and escapes from
 * each word. Unbalanced quotes run to the end, as a conservative reading.
 */
function simpleCommands(command: string): string[][] {
  return shellWordCommands(command).map((words) => words.map((word) => word.text))
}

function shellWordCommands(command: string): ShellWord[][] {
  const commands: ShellWord[][] = []
  let words: ShellWord[] = []
  let word = ""
  let inWord = false
  let quote: "'" | '"' | undefined
  let glob = false
  let opaque = false
  let variables: number[] = []
  let tilde = false
  const endWord = () => {
    if (inWord) {
      const homeOnly = variables.length === 1 && variables[0] === 0 && leadingHome.test(word)
      words.push({ text: word, glob, opaque: opaque || (variables.length > 0 && !homeOnly) || (tilde && !/^~(\/|$)/.test(word)) })
    }
    word = ""
    inWord = false
    glob = false
    opaque = false
    variables = []
    tilde = false
  }
  // A `$` the shell expands: not single-quoted, and followed by a name, a
  // special parameter, a brace, or (unquoted) an ANSI-C or locale string.
  const expands = (i: number, quoted: boolean) => /[A-Za-z0-9_{@*#?!$-]/.test(command[i + 1] ?? "") || (!quoted && /['"]/.test(command[i + 1] ?? ""))
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === "\\" && i + 1 < command.length) word += command[++i]
      else {
        if (char === "$" && expands(i, true)) variables.push(word.length)
        word += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
    } else if (char === "\\" && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (/[;&|\n()]/.test(char)) {
      endCommand()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      if (char === "$" && expands(i, false)) variables.push(word.length)
      else if (/[*?[]/.test(char)) glob = true
      else if (char === "{") opaque = true
      else if (char === "~" && !inWord) tilde = true
      word += char
      inWord = true
    }
  }
  endCommand()
  return commands
}

/** The command a simple command actually runs: assignments, reserved words, and wrappers stripped. */
function effectiveWords(words: readonly string[]): string[] {
  let rest = [...words]
  for (;;) {
    const head = rest[0]
    if (head === undefined) return rest
    if (reservedWords.has(head) || assignment.test(head)) {
      rest = rest.slice(1)
    } else if (commandWrappers.has(head)) {
      rest = rest.slice(1)
      // A wrapper's own options (`env -i`, `nice -n 5`) come before the command.
      while (rest[0]?.startsWith("-")) rest = rest.slice(rest[0] === "-n" ? 2 : 1)
    } else {
      return rest
    }
  }
}

/**
 * Every command a shell line can run, in a normalized `word word …` spelling
 * a prefix rule can judge: quoting and escapes removed, grouping and
 * wrappers stripped, and `sh -c` scripts and substitutions unfolded.
 */
export function normalizedCommands(command: string, depth = 0): string[] {
  if (depth > 4) return []
  const out: string[] = []
  for (const inner of substitutions(command)) out.push(...normalizedCommands(inner, depth + 1))
  for (const words of simpleCommands(command)) {
    const effective = effectiveWords(words)
    if (effective.length === 0) continue
    out.push(effective.join(" "))
    const script = shells.has(effective[0]!.split("/").at(-1)!) ? effective.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg)) : -1
    if (script !== -1 && effective[script + 1] !== undefined) out.push(...normalizedCommands(effective[script + 1]!, depth + 1))
  }
  return out
}

/**
 * The script a shell wrapper runs (`/bin/zsh -lc 'npm test'` runs
 * `npm test`), or the command itself when it is not exactly one such wrapper.
 * A harness that executes every command through the user's login shell hands
 * Convoy the wrapped form; policy judges the script, so a prefix rule such as
 * `npm test*` still matches.
 */
export function unwrapShellScript(command: string): string {
  const commands = simpleCommands(command)
  if (commands.length !== 1) return command
  const words = commands[0]!
  const shell = words[0]?.split("/").at(-1)
  if (!shell || !shells.has(shell) || words.length !== 3 || !/^-[a-z]*c[a-z]*$/.test(words[1]!)) return command
  return words[2]!.trim() || command
}

/** True when any spelling of a command line is hard-denied by the ruleset. */
export function commandHardDenied(command: string, rules: Readonly<Record<string, CommandEffect>>): boolean {
  return chainedCommandEffect(command, rules) === "deny"
}

/**
 * The words of each simple command a line runs, with what the shell still
 * expands in each (see `ShellWord`), and whether assignments, reserved words
 * or wrappers came before them (`prefixed`): `FOO=x cat a` runs `cat a` in a
 * changed environment.
 */
export function commandShellWords(command: string): { words: ShellWord[]; prefixed: boolean }[] {
  return shellWordCommands(command)
    .map((words) => {
      const kept = effectiveWords(words.map((word) => word.text)).length
      return { words: words.slice(words.length - kept), prefixed: kept !== words.length }
    })
    .filter((command) => command.words.length > 0)
}

/** The words of each simple command a line runs, quoting removed (see `simpleCommands`). */
export function commandWords(command: string): string[][] {
  return simpleCommands(command).map(effectiveWords).filter((words) => words.length > 0)
}

/** The combined effect of a possibly chained command: its strictest segment, unknown segments ask. */
function chainedCommandEffect(command: string, rules: Readonly<Record<string, CommandEffect>>): CommandEffect {
  // A hard denial anywhere in the raw text wins before any parsing doubt, and
  // so does one in any command the line runs however it is spelled.
  if (commandEffect(command.trim(), rules) === "deny") return "deny"
  if (normalizedCommands(command).some((candidate) => commandEffect(candidate, rules) === "deny")) return "deny"
  const segments = commandSegments(command)
  if (!segments || segments.length === 0) return "ask"
  let worst: CommandEffect = "allow"
  for (const segment of segments) {
    const effect = commandEffect(segment, rules) ?? "ask"
    if (effectRank[effect] > effectRank[worst]) worst = effect
  }
  return worst
}

/** Compares filesystem forms, so `/tmp` and `/private/tmp` (or a linked root) agree. */
function within(path: string, root: string): boolean {
  const rel = relative(realpathDeep(resolve(root)), realpathDeep(resolve(path)))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * The absolute, symlink-resolved form of a path resource: `~` and `$HOME`
 * expand, a relative path resolves against `cwd`, and the deepest existing
 * ancestor is realpath'd so a link inside the checkout cannot reach a
 * protected root. Undefined for a relative path with no cwd to resolve it.
 */
export function resolvePathResource(resource: string, cwd?: string): string | undefined {
  const expanded = resource.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir())
  if (!isAbsolute(expanded) && cwd === undefined) return undefined
  return realpathDeep(resolve(cwd ?? "/", expanded))
}

function realpathDeep(path: string): string {
  let head = path
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return path
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** The fixed directory part of a glob, which is what the glob can reach. */
export function staticGlobPrefix(pattern: string): string {
  const segments = pattern.split("/")
  const firstGlob = segments.findIndex((segment) => /[*?[{]/.test(segment))
  return firstGlob === -1 ? pattern : segments.slice(0, firstGlob).join("/") || (pattern.startsWith("/") ? "/" : ".")
}

const pathLike = /^(\/|~|\.|\$HOME|\$\{HOME\})|\//

/** The path-like words of a shell command (quotes stripped, `--opt=path` split). */
export function commandPathTokens(command: string): string[] {
  return command
    .split(/[\s;|&()<>]+/)
    .flatMap((word) => word.replace(/^['"]|['"]$/g, "").split("="))
    .filter((word) => word.length > 0 && word !== "/" && pathLike.test(word))
}

function reaches(path: string, roots: readonly string[], tree: boolean): boolean {
  return roots.some((root) => within(path, root) || (tree && within(root, path)))
}

function touchesDeniedRoot(request: ActionRequest, roots: readonly string[], cwd?: string): boolean {
  if (roots.length === 0) return false
  const resource = request.resource!
  if (request.intent === "execute") {
    // A command names the protected path in its text, or reaches it through a
    // relative, `~`, linked, or ancestor path a recursive command walks.
    if (roots.some((root) => resource.includes(root))) return true
    return commandPathTokens(resource).some((token) => {
      const target = resolvePathResource(staticGlobPrefix(token), cwd)
      return target !== undefined && reaches(target, roots, true)
    })
  }
  const target = resolvePathResource(resource, cwd)
  return target !== undefined && reaches(target, roots, request.scope === "tree")
}

/**
 * Decides one normalized action. No harness state is consulted; paths are
 * compared in their resolved filesystem form.
 */
export function evaluateAction(request: ActionRequest, config: PolicyConfig, state: PolicyState = {}): PolicyDecision {
  for (const rule of config.hardDeny ?? []) {
    if (matchesRule(request, rule)) {
      return { effect: "deny", reason: `hard-denied ${request.tool}` }
    }
  }

  const cwd = request.cwd ?? config.cwd
  if (request.resource !== undefined && touchesDeniedRoot(request, config.denyRoots ?? [], cwd)) {
    return { effect: "deny", reason: `${request.tool} may not touch a protected path` }
  }

  const command = request.intent === "execute" && config.commands && request.resource !== undefined
    ? chainedCommandEffect(request.resource, config.commands)
    : undefined
  if (command === "deny") return { effect: "deny", reason: `hard-denied command for ${request.tool}` }

  // An unclassifiable action never gains access by default, in any mode.
  if (request.intent === "other") {
    return { effect: "deny", reason: `unclassifiable action ${request.tool}` }
  }

  if (config.mode === "read-only" && readOnlyDenied.has(request.intent)) {
    return { effect: "deny", reason: `read-only step may not ${request.intent}` }
  }

  if (config.mode === "verify") {
    if (verifyDenied.has(request.intent)) {
      return { effect: "deny", reason: `verification step may not ${request.intent}` }
    }
    if (request.intent === "execute" && command !== "allow" && !isVerifyAllowed(request, config.verifyAllow ?? [])) {
      return { effect: "deny", reason: "command is not an approved verification command" }
    }
  }

  if (request.intent === "write" && config.requireAdvisorBeforeWrite && !state.advisorSatisfied) {
    return { effect: "deny", reason: "blocked until the advisor consultation is satisfied" }
  }

  if (request.intent === "read") {
    if (config.readRoots) {
      const target = request.resource === undefined ? cwd : resolvePathResource(request.resource, cwd)
      const roots = [...(config.writeRoots ?? []), ...config.readRoots]
      if (target === undefined || !roots.some((root) => within(target, root))) {
        return { effect: "deny", reason: "read outside the step's checkout, run directory, and attachments" }
      }
    }
    return { effect: "allow", reason: "read allowed" }
  }

  if (request.intent === "write" && config.writeRoots) {
    const target = request.resource === undefined ? undefined : resolvePathResource(request.resource, cwd)
    if (target !== undefined && config.writeRoots.some((root) => within(target, root))) {
      return { effect: "allow", reason: "write inside the step's checkout" }
    }
    return { effect: "deny", reason: "write outside the step's checkout and run directory" }
  }

  if (command === "allow") return { effect: "allow", reason: "allowlisted command" }
  if (!askWorthy.has(request.intent)) return { effect: "allow", reason: `${request.intent} allowed` }

  switch (config.approvals) {
    case "auto":
      return { effect: "allow", reason: "auto-approved" }
    case "smart":
      return { effect: "ask", reason: "judge decides" }
    case "interactive":
    default:
      return { effect: "ask", reason: "operator decides" }
  }
}
