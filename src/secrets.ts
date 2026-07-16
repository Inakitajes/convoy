// Secrets live in the macOS Keychain (service "convoy", account = provider),
// never in env vars or files: `security add-generic-password` prompts for the
// value itself with stdio inherited, so the secret never crosses convoy's
// argv, environment, or disk in the clear. Items created through the
// `security` binary keep it in their ACL, so later reads don't raise GUI
// prompts — the same mechanism runway uses for Claude Code's credential.

const service = "convoy"

export function keychainAvailable() {
  return process.platform === "darwin"
}

/** Interactive: `security` asks for the secret (hidden, twice). -U updates an existing item. */
export async function storeKeychainSecret(account: string): Promise<boolean> {
  if (!keychainAvailable()) return false
  const proc = Bun.spawn(["security", "add-generic-password", "-U", "-s", service, "-a", account, "-w"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return (await proc.exited) === 0
}

export async function readKeychainSecret(account: string): Promise<string | undefined> {
  if (!keychainAvailable()) return undefined
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", account, "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return undefined
    const secret = output.trim()
    return secret.length > 0 ? secret : undefined
  } catch {
    return undefined
  }
}

export async function deleteKeychainSecret(account: string): Promise<boolean> {
  if (!keychainAvailable()) return false
  const proc = Bun.spawn(["security", "delete-generic-password", "-s", service, "-a", account], {
    stdout: "ignore",
    stderr: "ignore",
  })
  return (await proc.exited) === 0
}
