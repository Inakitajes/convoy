/** Re-invoking this Convoy as an internal subcommand (`convoy hook`, `convoy mcp`) from a harness it launches. */

import { convoySourceEntry, isOfficialStandaloneExecutable } from "../update"

/**
 * The argv that re-invokes this Convoy with an internal subcommand: a release
 * executable runs `execPath <sub>`, a source checkout re-runs its entry script
 * with the same runtime flags.
 */
export function convoySubcommandArgv(sub: string, standalone = isOfficialStandaloneExecutable()): string[] {
  if (standalone) return [process.execPath, sub]
  return [process.execPath, ...process.execArgv, convoySourceEntry, sub]
}

/** POSIX-quotes an argv into one shell command line (Claude runs hooks through a shell). */
export function shellCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ")
}
