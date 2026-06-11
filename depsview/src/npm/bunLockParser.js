/**
 * bun.lock parser (text format, Bun 1.2+).
 *
 * bun.lock is a JSON file with two top-level objects:
 *
 *   workspaces  — maps workspace path (e.g. "") to a manifest-like object
 *                 that contains `dependencies` and `devDependencies` maps.
 *                 Used here solely to identify which top-level packages are
 *                 dev-only so they can be filtered when includeTests=false.
 *
 *   packages    — maps "name@version" keys to a 4-element array:
 *                   [0] "name@version"  (redundant, same as the key)
 *                   [1] resolved tarball URL, optionally followed by "#hash"
 *                   [2] peer dependency constraints object (ignored here)
 *                   [3] integrity string
 *
 * Dev-filtering caveat: bun.lock does not annotate transitive packages with a
 * dev flag.  Only the *direct* devDependency names are known from workspaces.
 * This parser excludes any package whose name appears in at least one workspace's
 * devDependencies but in *none* of the workspaces' regular dependencies.  This
 * matches the same best-effort approach used by the pnpm v9 parser.
 *
 * Binary bun.lockb files (older Bun versions) are not supported.
 */

/**
 * Parses the "name@version" key used by the packages section.
 * Scoped packages (e.g. @babel/core@7.24.0) are handled by finding the last @.
 *
 * @param {string} key - raw key from the packages object, e.g. "lodash@4.17.21"
 * @returns {{ name: string, version: string }|null} null when the key cannot be parsed
 */
function parseBunPackageKey(key) {
  // The last @ separates the package name from the version.
  // Guard: lastAt must be > 0 so a bare scoped name "@scope/pkg" (no version) is rejected.
  const lastAt = key.lastIndexOf('@');
  if (lastAt <= 0) return null;
  const name    = key.slice(0, lastAt);
  const version = key.slice(lastAt + 1);
  if (!name || !version) return null;
  return { name, version };
}

/**
 * Strips the "#hash" integrity suffix that Bun appends to some resolved URLs.
 * Returns the URL unchanged when no hash suffix is present.
 *
 * @param {string} url - resolved tarball URL, possibly containing "#…"
 * @returns {string}
 */
function stripUrlHash(url) {
  const hashIdx = url.indexOf('#');
  return hashIdx === -1 ? url : url.slice(0, hashIdx);
}

/**
 * Collects the set of direct dependency names that appear in devDependencies
 * across all workspaces but never in any workspace's production dependencies.
 * These are the only packages safe to exclude when includeTests=false.
 *
 * @param {Record<string, { dependencies?: Record<string, string>, devDependencies?: Record<string, string> }>} workspaces
 * @returns {Set<string>} package names that are dev-only across all workspaces
 */
function collectDevOnlyNames(workspaces) {
  const prodNames = new Set();
  const devNames  = new Set();

  for (const ws of Object.values(workspaces)) {
    for (const name of Object.keys(ws.dependencies    ?? {})) prodNames.add(name);
    for (const name of Object.keys(ws.devDependencies ?? {})) devNames.add(name);
  }

  // A name is dev-only when it never appears in production deps of any workspace.
  const devOnly = new Set();
  for (const name of devNames) {
    if (!prodNames.has(name)) devOnly.add(name);
  }
  return devOnly;
}

/**
 * Removes trailing commas from a JSONC string so JSON.parse can handle it.
 * bun.lock uses trailing commas after the last property/element in objects and
 * arrays (JSONC syntax), which standard JSON.parse rejects.
 *
 * The regex `,(\s*[}\]])` matches a comma followed by optional whitespace and
 * a closing brace or bracket. It is safe from ReDoS: no nested quantifiers, and
 * \s* is bounded by the single non-whitespace character that follows it.
 *
 * This approach is safe for lock file content because package names and
 * integrity hashes never contain the literal substring ",}" or ",]".
 *
 * @param {string} str - raw JSONC string
 * @returns {string} string with trailing commas removed
 */
function stripTrailingCommas(str) {
  return str.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parses a bun.lock text file and returns a flat, deduplicated list of installed packages.
 *
 * Algorithm:
 *   1. Strip trailing commas (bun.lock uses JSONC syntax), then JSON.parse.
 *   2. Walk the `packages` object. For each entry, parse the canonical
 *      "name@version" from value[0] (not the key, which can be a bare name or
 *      a "parent/child" path for nested dependency resolution entries).
 *   3. Extract the resolved tarball URL from index 1 of the value array and
 *      strip any trailing "#hash".
 *   4. When includeTests is false, derive the set of dev-only direct dependency
 *      names from the `workspaces` section and exclude matching packages.
 *   5. Deduplicate by "name@version" (the key itself is already unique in JSON,
 *      so the Map is used to ensure the contract holds even if the file is malformed).
 *
 * @param {string}  content              - raw bun.lock file content
 * @param {boolean} [includeTests=false] - when true, dev-only packages are included
 * @returns {Array<{ name: string, version: string, resolved: string|null }>}
 * @throws {SyntaxError} when the content is not valid JSONC
 */
function parseBunLock(content, includeTests = false) {
  const data = JSON.parse(stripTrailingCommas(content));

  const workspaces = data.workspaces ?? {};
  const packages   = data.packages   ?? {};

  const devOnly = includeTests ? new Set() : collectDevOnlyNames(workspaces);

  /** @type {Map<string, { name: string, version: string, resolved: string|null }>} */
  const pkgMap = new Map();

  for (const value of Object.values(packages)) {
    // value[0] is always the canonical "name@version" string regardless of the key
    // format. Keys can be plain "name@version", bare "name" (no version suffix for
    // single-installed packages), or "parent/child" paths for nested dependency
    // resolution entries — using the key directly would produce garbage names.
    const canonical = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
    if (!canonical) continue;
    const parsed = parseBunPackageKey(canonical);
    if (!parsed) continue;

    const { name, version } = parsed;
    if (!includeTests && devOnly.has(name)) continue;

    const dedupeKey = `${name}@${version}`;
    if (pkgMap.has(dedupeKey)) continue;

    const rawUrl  = Array.isArray(value) && typeof value[1] === 'string' ? value[1] : null;
    // Only accept https:// URLs — rejects file:, javascript:, and internal-network schemes.
    const resolved = rawUrl && rawUrl.startsWith('https://') ? stripUrlHash(rawUrl) : null;

    pkgMap.set(dedupeKey, { name, version, resolved });
  }

  return Array.from(pkgMap.values());
}

export { parseBunLock, parseBunPackageKey, stripUrlHash, stripTrailingCommas, collectDevOnlyNames };
