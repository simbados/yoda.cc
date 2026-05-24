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
 * Splits a list of lock-file packages into public and non-public arrays.
 * Non-public packages are reported in `privatePkgs` with their resolved URL so
 * callers can surface them to the user — the URL itself reveals whether this is
 * a private registry, a GitHub Package Registry, a direct tarball, etc.
 * Packages with no resolved field (workspace roots, bundled packages) are treated
 * as public.
 * Does not mutate the input array.
 * @param {Array<{ name: string, version: string, resolved: string|null }>} packages
 * @returns {{
 *   publicPkgs:   Array<{ name: string, version: string }>,
 *   privateCount: number,
 *   privatePkgs:  Array<{ name: string, url: string }>
 * }}
 */
export function partitionNpmPackages(packages) {
  const publicPkgs  = [];
  const privatePkgs = [];

  for (const pkg of packages) {
    if (isPublicNpmResolved(pkg.resolved)) {
      publicPkgs.push({ name: pkg.name, version: pkg.version });
    } else {
      privatePkgs.push({ name: pkg.name, url: pkg.resolved });
    }
  }

  return { publicPkgs, privateCount: privatePkgs.length, privatePkgs };
}
