/**
 * Dependency-boundary check (change `runner-parity-opencode-v2`, task 2.5).
 *
 * Agent harness packages must be confined to runner adapter boundaries. This
 * module finds vendor imports and reports the ones that appear outside an
 * adapter boundary and outside a burn-down allowlist. The allowlist is a
 * ratchet: it may only shrink as core modules migrate to the neutral ports.
 *
 * Pure and source-list driven so it is unit-testable without touching disk.
 */

export const vendorPackages = ["@opencode-ai/sdk", "@opencode/client", "@opencode/plugin", "@opencode/schema"] as const

/** Files under this prefix are adapter boundaries and may import vendor packages. */
export const adapterBoundaryPrefix = "src/runners/"

/** Individual core modules that are themselves harness boundaries. */
export const adapterBoundaryFiles = ["src/opencode-client.ts"] as const

export type ModuleSource = { path: string; text: string }
export type VendorImport = { path: string; pkg: string }

export function isAdapterBoundary(path: string): boolean {
  return path.startsWith(adapterBoundaryPrefix) || (adapterBoundaryFiles as readonly string[]).includes(path)
}

function vendorFor(specifier: string): string | undefined {
  return vendorPackages.find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))
}

/** Every vendor import in the given module sources. */
export function findVendorImports(sources: readonly ModuleSource[]): VendorImport[] {
  const out: VendorImport[] = []
  for (const source of sources) {
    const specifiers = [
      ...source.text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ]
    for (const match of specifiers) {
      const specifier = match[1]
      if (!specifier) continue
      const pkg = vendorFor(specifier)
      if (pkg) out.push({ path: source.path, pkg })
    }
  }
  return out
}

/**
 * Vendor imports outside an adapter boundary that are not on the burn-down
 * allowlist. A non-empty result means the boundary was crossed.
 */
export function boundaryViolations(
  sources: readonly ModuleSource[],
  allowlist: readonly string[] = [],
): VendorImport[] {
  const allowed = new Set(allowlist)
  return findVendorImports(sources).filter((entry) => !isAdapterBoundary(entry.path) && !allowed.has(entry.path))
}
