/**
 * Utilities for filtering npm packages by registry origin.
 *
 * package-lock.json (v1/v2/v3) and pnpm-lock.yaml both record a `resolved`
 * URL for every installed package. When that URL does not point to the public
 * npm registry the package lives in a private or custom registry and cannot be
 * resolved by depsview's public API calls — it is silently skipped.
 *
 * The public npm registry is identified by the hostname `registry.npmjs.org`.
 * Packages with no `resolved` field (e.g. workspace root entries, bundled
 * packages) are treated as public so they still go through resolution.
 */

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Returns true when a package's resolved URL points to the public npm registry,
 * or when no resolved URL is recorded (treated as public).
 * @param {string|null|undefined} resolved - the resolved URL from the lock file
 * @returns {boolean}
 */
export function isPublicNpmResolved(resolved) {
  if (!resolved) return true;
  return resolved.startsWith(PUBLIC_NPM_REGISTRY);
}

/**
 * Splits a list of lock-file packages into public and private arrays.
 * Returns { publicPkgs, privateCount } so callers can report the skip count.
 * Does not mutate the input array.
 * @param {Array<{ name: string, version: string, resolved: string|null }>} packages
 * @returns {{ publicPkgs: Array<{ name: string, version: string }>, privateCount: number }}
 */
export function partitionNpmPackages(packages) {
  const publicPkgs = [];
  let privateCount = 0;
  for (const pkg of packages) {
    if (isPublicNpmResolved(pkg.resolved)) {
      publicPkgs.push({ name: pkg.name, version: pkg.version });
    } else {
      privateCount++;
    }
  }
  return { publicPkgs, privateCount };
}
