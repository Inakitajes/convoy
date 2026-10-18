import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"

import type { PermissionAdditions } from "./types"

/**
 * The bash permission policy convoy hands to opencode: which shell commands run
 * without asking, which are always denied, and how a project may extend either
 * list. This owns convoy's security-relevant command policy; agents.ts only
 * consumes the assembled policy when wiring the opencode config.
 */

export const noAdditions: PermissionAdditions = { allow: [], deny: [] }

// Safe-by-default commands across the toolchains convoy targets. Anything not
// listed falls through to "ask" (or auto-accept when --yolo / shift+tab is on).
export const baseAllowBashPatterns = [
  // Flutter / Dart toolchain
  "flutter analyze*",
  "flutter test*",
  "flutter pub get",
  "flutter pub upgrade",
  "flutter pub outdated",
  "flutter pub deps*",
  "flutter format*",
  "flutter clean",
  "flutter doctor*",
  "flutter --version",
  "dart analyze*",
  "dart test*",
  "dart format*",
  "dart pub get",
  "dart pub upgrade",
  "dart pub outdated",
  "dart pub deps*",
  "dart run build_runner*",
  "dart --version",
  // Web / JavaScript / TypeScript checks
  "npm test*",
  "npm run test*",
  "npm run lint*",
  "npm run typecheck*",
  "npm run check*",
  "npm run build*",
  "npm --version",
  "pnpm test*",
  "pnpm run test*",
  "pnpm run lint*",
  "pnpm run typecheck*",
  "pnpm run check*",
  "pnpm run build*",
  "pnpm lint*",
  "pnpm typecheck*",
  "pnpm check*",
  "pnpm build*",
  "pnpm --version",
  "yarn test*",
  "yarn run test*",
  "yarn run lint*",
  "yarn run typecheck*",
  "yarn run check*",
  "yarn run build*",
  "yarn lint*",
  "yarn typecheck*",
  "yarn check*",
  "yarn build*",
  "yarn --version",
  "bun test*",
  "bun run test*",
  "bun run lint*",
  "bun run typecheck*",
  "bun run check*",
  "bun run build*",
  "bun --version",
  "node --version",
  "tsc --noEmit*",
  "npm run format*",
  "pnpm run format*",
  "pnpm format*",
  "yarn run format*",
  "yarn format*",
  "bun run format*",
  // Python checks
  "pytest*",
  "python -m pytest*",
  "python3 -m pytest*",
  "ruff check*",
  "ruff format*",
  "mypy*",
  // Go checks
  "go test*",
  "go vet*",
  "go fmt*",
  // Rust checks
  "cargo test*",
  "cargo check*",
  "cargo fmt*",
  "cargo clippy*",
  // Make: only well-known read/check targets; bare "make*" could run anything
  "make test",
  "make lint",
  "make check",
  "make build",
  // Common E2E dry-run/listing commands
  "maestro test --dry-run*",
  "maestro --version",
  "npm run e2e -- --list*",
  "pnpm run e2e -- --list*",
  "yarn run e2e -- --list*",
  // read-only git
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git rev-parse*",
  // listing forms only: a bare "git branch*" would also allow -D/-m
  "git branch",
  "git branch -a",
  "git branch -r",
  "git branch -v",
  "git branch -vv",
  "git branch --list*",
  "git branch --show-current",
  "git ls-files*",
  "git ls-tree*",
  "git config --get*",
  "git stash list*",
  "git remote -v",
  "git --version",
  // Generic read-only shell. Note the policy matches command prefixes, so
  // shell redirection ("ls > file") can still write; that has to be caught
  // by opencode itself, not by patterns. find is excluded on purpose: its
  // -delete/-exec arguments execute arbitrary destructive commands.
  "pwd",
  "ls*",
  "cat*",
  "head*",
  "tail*",
  "grep*",
  "rg*",
  "wc*",
  "echo*",
  "printf*",
  "which*",
  "whoami",
  "file*",
  "tree*",
  "stat*",
  "jq*",
  "du -sh*",
  "true",
  "false",
]

// Hard denylist. Never relaxed — --yolo and the shift+tab auto-accept toggle
// only affect commands that would otherwise *ask*. This protects against
// accidents (pushes, recursive deletes, installs), not against a malicious
// agent: agents can edit repo code that later runs, so allowlisted scripts
// imply trusting the repo contents anyway.
export const denyBashPatterns = [
  // remote operations - always Convoy's job
  "git push*",
  "git push",
  "git fetch*",
  "git pull*",
  "git remote add*",
  "git remote set-url*",
  "git remote rm*",
  "git remote remove*",
  // committing - also always Convoy's job: one commit per phase, authored by
  // convoy and never signed. An agent commit would swallow the phase's own
  // commit and can hang the run on an interactive signing prompt.
  "git commit*",
  "git commit",
  // exact + spaced forms so ghc/ghq and similar tools aren't denied too
  "gh",
  "gh *",
  // publishing / deployment
  "npm publish*",
  "yarn publish*",
  "pnpm publish*",
  "bun publish*",
  "npm run deploy*",
  "yarn run deploy*",
  "pnpm run deploy*",
  "bun run deploy*",
  "vercel*",
  "netlify*",
  "firebase deploy*",
  // history rewrite or destructive git
  "git reset --hard*",
  "git reset --keep*",
  "git reset --merge*",
  "git rebase*",
  "git filter-branch*",
  "git filter-repo*",
  "git clean -f*",
  "git clean -d*",
  "git checkout .*",
  "git restore .*",
  "git worktree*",
  // recursive removes against the filesystem root or home
  "rm -rf /*",
  "rm -rf /",
  "rm -fr /*",
  "rm -fr /",
  "rm -rf ~*",
  "rm -fr ~*",
  "rm -rf $HOME*",
  "rm -fr $HOME*",
  "rm -rf ${HOME}*",
  "rm -fr ${HOME}*",
  // download-and-execute patterns
  "curl* | sh*",
  "curl* | bash*",
  "curl* | zsh*",
  "wget* | sh*",
  "wget* | bash*",
  "wget* | zsh*",
  "curl* |sh*",
  "curl* |bash*",
  "curl* |zsh*",
  "wget* |sh*",
  "wget* |bash*",
  "wget* |zsh*",
  // package install
  "npm install*",
  "npm i *",
  "npm ci*",
  "yarn install*",
  "yarn add*",
  "pnpm install*",
  "pnpm add*",
  "bun install*",
  "bun add*",
  "brew install*",
  "pip install*",
  "pipx install*",
  "cargo install*",
  "go install*",
  "gem install*",
  // privilege escalation (exact + spaced forms: "su*" would deny supabase, subl…)
  "sudo*",
  "su",
  "su *",
  "doas",
  "doas *",
]

// Script names safe to run through the package manager; suffixes like
// test:unit or build-storybook stay covered by the separator group.
const safeScriptName = /^(test|lint|typecheck|type-check|check|build|format|validate)([:._-].*)?$/
const dangerousScriptHint = /(deploy|publish|release|migrate|seed|reset)/i

/** Exact allow patterns for the target repo's own package.json scripts that look like checks. */
export function projectScriptAllowPatterns(targetDir = process.cwd()): string[] {
  const path = join(targetDir, "package.json")
  if (!isFile(path)) return []

  let scripts: Record<string, unknown>
  try {
    scripts = (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return []
  }

  const out: string[] = []
  for (const name of Object.keys(scripts)) {
    if (!safeScriptName.test(name) || dangerousScriptHint.test(name)) continue
    // Exact name plus a "name *" args form: "npm run build*" would also match
    // an unrelated "build-and-push" script, the space keeps it scoped.
    for (const runner of ["npm run", "pnpm run", "pnpm", "yarn run", "yarn", "bun run"]) {
      out.push(`${runner} ${name}`, `${runner} ${name} *`)
    }
  }
  return out
}

/**
 * Assembles a bash policy from the shared lists: denied patterns stay deny,
 * the allowlist is silently allowed, and everything else is "ask".
 * Config additions only ever extend the lists: a project can deny more and
 * allow more, but a config allow can never resurrect a denied pattern.
 */
/**
 * Insertion order is the evaluation order: OpenCode V2 turns this map into an
 * ordered ruleset where the last matching rule wins. The ask fallback comes
 * first, allows refine it, and denials come last so they always win.
 */
function assembleBashPolicy(targetDir: string, additions: PermissionAdditions, privateDirs: readonly string[]): Record<string, "allow" | "deny" | "ask"> {
  const policy: Record<string, "allow" | "deny" | "ask"> = { "*": "ask" }
  const denied = new Set([...denyBashPatterns, ...additions.deny, ...privateDirs.flatMap(privateDirBashPatterns)])
  for (const pattern of [...baseAllowBashPatterns, ...projectScriptAllowPatterns(targetDir), ...additions.allow]) {
    if (denied.has(pattern)) continue
    policy[pattern] = "allow"
  }
  for (const pattern of denied) policy[pattern] = "deny"
  return policy
}

/**
 * `privateDirs` are owner-only secrets dirs (the run's server password and
 * bridge-token plugins, Convoy's authoring secrets): every command naming one,
 * or recursively searching one of its ancestors, is denied so an allowlisted
 * `cat`/`grep` cannot read it silently.
 */
export function bashPolicy(
  targetDir = process.cwd(),
  additions: PermissionAdditions = noAdditions,
  privateDirs: readonly string[] = [],
): Record<string, "allow" | "deny" | "ask"> {
  return assembleBashPolicy(targetDir, additions, privateDirs)
}

// File names only the private dir holds, so a relative or `..` path to them is
// caught even when it never spells the private dir out.
const privateFileHints = ["server-auth.json", "private/plugins", "private/server-auth"]

/**
 * Deny patterns keeping a private dir out of shell commands. Prefix rules are
 * not a sandbox (see denyBashPatterns), so this closes the silent paths: the
 * dir in every spelling a shell expands (absolute, `~`, `$HOME`), its secret
 * file names, and any command naming one of its ancestors as a whole word,
 * which is how a recursive `grep`/`rg` would reach it.
 */
export function privateDirBashPatterns(privateDir: string): string[] {
  if (!isAbsolute(privateDir)) throw new Error(`private dir must be absolute, got: ${JSON.stringify(privateDir)}`)
  const patterns = new Set<string>()
  for (const spelling of shellSpellings(privateDir)) patterns.add(`*${spelling}*`)
  for (const hint of privateFileHints) patterns.add(`*${hint}*`)
  for (let ancestor = dirname(privateDir); ; ancestor = dirname(ancestor)) {
    for (const spelling of shellSpellings(ancestor)) {
      for (const form of [spelling, ancestor === "/" ? undefined : `${spelling}/`]) {
        if (form === undefined) continue
        patterns.add(`* ${form}`)
        patterns.add(`* ${form} *`)
      }
    }
    if (ancestor === dirname(ancestor)) break
  }
  return [...patterns]
}

function shellSpellings(path: string): string[] {
  const home = homedir()
  const rel = relative(home, path)
  if (rel.startsWith("..") || isAbsolute(rel)) return [path]
  if (rel === "") return [path, "~", "$HOME", "${HOME}"]
  return [path, `~/${rel}`, `$HOME/${rel}`, "${HOME}/" + rel]
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
