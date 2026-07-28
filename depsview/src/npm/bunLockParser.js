/**
 * bun.lock parser (text format, Bun 1.2+).
 *
 * bun.lock is a JSONC file with two top-level objects depsview reads:
 *
 *   workspaces  — maps workspace path (e.g. "") to a manifest-like object
 *                 that contains `dependencies` and `devDependencies` maps.
 *                 Used here solely to identify which top-level packages are
 *                 dev-only so they can be filtered when includeTests=false.
 *
 *   packages    — maps a key (a flat "name" for root-level entries or a
 *                 "parent/child/name" path for nested resolution entries) to
 *                 a JSON array whose shape depends on Bun's Resolution.Tag.
 *
 * Per Bun's text-lockfile writer (src/install/lockfile/bun.lock.zig), the
 * array shape varies by resolution kind. value[0] is always a canonical
 * "name@<spec>" string identifying the kind:
 *
 *   ┌──────────────────────┬─────────────────────────────────┬────────┐
 *   │ kind                 │ value[0] shape                  │ length │
 *   ├──────────────────────┼─────────────────────────────────┼────────┤
 *   │ npm registry         │ name@1.2.3                      │ 4      │
 *   │   value: [canonical, registryUrl, infoObject, integrity]        │
 *   │ git                  │ name@git+https://…              │ 3–4    │
 *   │ github               │ name@github:owner/repo#sha      │ 3–4    │
 *   │ workspace            │ name@workspace:packages/web     │ 1      │
 *   │ folder               │ name@file:./local               │ 2      │
 *   │ symlink              │ name@link:../sibling            │ 2      │
 *   │ local_tarball        │ name@./pkg-1.0.0.tgz            │ 2–3    │
 *   │ remote_tarball       │ name@https://example.com/p.tgz  │ 2–3    │
 *   │ root                 │ name@root:                      │ 2      │
 *   │ npm alias            │ alias@npm:real-name@1.2.3       │ 4      │
 *   └──────────────────────┴─────────────────────────────────┴────────┘
 *
 * Routing in this parser:
 *
 *   - npm:                resolved against the public registry as usual.
 *   - workspace, root:    silently skipped (monorepo cross-link / the project
 *                         itself — not third-party packages).
 *   - npm alias:          silently skipped (the underlying name@version can be
 *                         extracted but cross-registry alias resolution is not
 *                         yet plumbed through depsview).
 *   - file, link, git,
 *     github, tarball:    surfaced via parseBunDangerousDeps() so they appear
 *                         in the "non-standard sources" panel rather than
 *                         being silently dropped or hitting registry.npmjs.org
 *                         with a junk version string.
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
 * Finds the position of the '@' that separates the package name from the
 * version/spec in a canonical "name@spec" string. Skips past a leading "@" and
 * the following "/" so scoped packages are handled correctly, and prefers the
 * *first* '@' after the name. That is critical for non-npm canonicals where
 * the spec itself contains '@' — e.g. "name@git+ssh://git@github.com/foo.git"
 * or "alias@npm:real@1.2.3" — which a naive lastIndexOf('@') would misparse.
 *
 * @param {string} canonical
 * @returns {number} index of the delimiter, or -1 when none was found
 */
function findVersionDelimiter(canonical) {
  let searchStart = 0;
  if (canonical.startsWith("@")) {
    const slashIdx = canonical.indexOf("/");
    if (slashIdx === -1) return -1;
    searchStart = slashIdx + 1;
  }
  return canonical.indexOf("@", searchStart);
}

/**
 * Categorises a canonical "name@<spec>" string into one of Bun's resolution
 * kinds by inspecting the spec prefix. npm semver versions never start with
 * any of these reserved prefixes ("workspace:", "file:", "https://", etc.),
 * so prefix matching is unambiguous.
 *
 * Returns null when the canonical cannot be split at all (no '@' delimiter,
 * empty name, or empty spec).
 *
 * @param {string} canonical - canonical "name@<spec>" string from value[0]
 * @returns {{ name: string, kind: 'npm'|'workspace'|'root'|'alias'|'file'|'link'|'git'|'github'|'tarball', version?: string, spec?: string }|null}
 */
function detectBunResolution(canonical) {
  const atIdx = findVersionDelimiter(canonical);
  if (atIdx <= 0) return null;
  const name = canonical.slice(0, atIdx);
  const spec = canonical.slice(atIdx + 1);
  if (!name || !spec) return null;

  if (spec.startsWith("workspace:")) return { name, kind: "workspace", spec };
  if (spec.startsWith("root:")) return { name, kind: "root", spec };
  if (spec.startsWith("npm:")) return { name, kind: "alias", spec };
  if (spec.startsWith("file:")) return { name, kind: "file", spec };
  if (spec.startsWith("link:")) return { name, kind: "link", spec };
  if (spec.startsWith("github:")) return { name, kind: "github", spec };
  if (spec.startsWith("git+")) return { name, kind: "git", spec };
  if (spec.startsWith("https://") || spec.startsWith("http://")) {
    return { name, kind: "tarball", spec };
  }

  return { name, kind: "npm", version: spec };
}

/**
 * Back-compat wrapper around detectBunResolution. Returns the parsed
 * { name, version } only for plain npm-registry entries; returns null for
 * every other resolution kind (workspace, root, alias, file, link, git,
 * github, tarball) so callers using this for npm-only lookups do not see
 * junk version strings.
 *
 * @param {string} canonical
 * @returns {{ name: string, version: string }|null}
 */
function parseBunPackageKey(canonical) {
  const res = detectBunResolution(canonical);
  if (!res || res.kind !== "npm") return null;
  return { name: res.name, version: res.version };
}

/**
 * Strips the "#hash" integrity suffix that Bun appends to some resolved URLs.
 * Returns the URL unchanged when no hash suffix is present.
 *
 * @param {string} url - resolved tarball URL, possibly containing "#…"
 * @returns {string}
 */
function stripUrlHash(url) {
  const hashIdx = url.indexOf("#");
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
  const devNames = new Set();

  for (const ws of Object.values(workspaces)) {
    for (const name of Object.keys(ws.dependencies ?? {})) prodNames.add(name);
    for (const name of Object.keys(ws.devDependencies ?? {})) devNames.add(name);
  }

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
  return str.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parses a bun.lock text file and returns a flat, deduplicated list of
 * plain-npm-registry packages.
 *
 * Algorithm:
 *   1. Strip trailing commas (bun.lock uses JSONC syntax), then JSON.parse.
 *   2. Walk the `packages` object. For each entry, derive a canonical
 *      "name@<spec>" from value[0] (the JSON key is unreliable for non-root
 *      entries — it can be a bare "name" or a "parent/child/name" path).
 *   3. Categorise the entry via detectBunResolution(). Non-npm kinds are
 *      filtered out here — workspace/root/alias entries are silently dropped,
 *      and file/link/git/github/tarball entries are surfaced separately via
 *      parseBunDangerousDeps so they appear in the non-standard sources block.
 *   4. Extract the resolved tarball URL from value[1] (strings only — value[1]
 *      is an info object for non-npm variants and is treated as no URL).
 *   5. When includeTests is false, derive the set of dev-only direct dep
 *      names from the `workspaces` section and exclude matching packages.
 *   6. Deduplicate by "name@version".
 *
 * @param {string}  content              - raw bun.lock file content
 * @param {boolean} [includeTests=false] - when true, dev-only packages are included
 * @returns {Array<{ name: string, version: string, resolved: string|null }>}
 * @throws {SyntaxError} when the content is not valid JSONC
 */
function parseBunLock(content, includeTests = false) {
  const data = JSON.parse(stripTrailingCommas(content));

  const workspaces = data.workspaces ?? {};
  const packages = data.packages ?? {};

  const devOnly = includeTests ? new Set() : collectDevOnlyNames(workspaces);

  /** @type {Map<string, { name: string, version: string, resolved: string|null }>} */
  const pkgMap = new Map();

  for (const value of Object.values(packages)) {
    const canonical = Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
    if (!canonical) continue;

    const res = detectBunResolution(canonical);
    if (!res || res.kind !== "npm") continue;

    const { name, version } = res;
    if (!includeTests && devOnly.has(name)) continue;

    const dedupeKey = `${name}@${version}`;
    if (pkgMap.has(dedupeKey)) continue;

    const rawUrl = Array.isArray(value) && typeof value[1] === "string" ? value[1] : null;
    // Only accept https:// URLs — rejects file:, javascript:, and internal-network schemes.
    const resolved = rawUrl && rawUrl.startsWith("https://") ? stripUrlHash(rawUrl) : null;

    pkgMap.set(dedupeKey, { name, version, resolved });
  }

  return Array.from(pkgMap.values());
}

/**
 * Extracts non-registry package entries from bun.lock for the
 * "non-standard sources" panel. Walks the same `packages` map as parseBunLock,
 * categorises each entry, and emits one row per file/link/git/github/tarball
 * entry. Workspace, root, npm-alias, and plain npm entries are excluded —
 * workspace and root are not third-party sources, npm aliases are skipped for
 * now, and plain npm entries already go through the standard resolver.
 *
 * Returns an empty array (never throws) when the file cannot be parsed —
 * dangerous-dep detection should never cause the whole npm pipeline to fail.
 * Output entries are deduplicated by (name, spec) so a package referenced from
 * multiple positions in the dependency graph appears once.
 *
 * @param {string} content - raw bun.lock file content
 * @returns {Array<{ name: string, spec: string, reason: string }>}
 */
function parseBunDangerousDeps(content) {
  let data;
  try {
    data = JSON.parse(stripTrailingCommas(content));
  } catch {
    return [];
  }

  const packages = data?.packages ?? {};

  /** Human-readable reason strings shown beside each entry in the panel. */
  const REASON = {
    file: "local folder reference (file:)",
    link: "symlinked folder (link:)",
    git: "git source (git+)",
    github: "github shorthand (github:)",
    tarball: "direct tarball URL",
  };

  const seen = new Set();
  const out = [];
  for (const value of Object.values(packages)) {
    const canonical = Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
    if (!canonical) continue;

    const res = detectBunResolution(canonical);
    if (!res || !REASON[res.kind]) continue;

    const dedupeKey = `${res.name}|${res.spec}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ name: res.name, spec: res.spec, reason: REASON[res.kind] });
  }
  return out;
}

export {
  parseBunLock,
  parseBunDangerousDeps,
  parseBunPackageKey,
  detectBunResolution,
  findVersionDelimiter,
  stripUrlHash,
  stripTrailingCommas,
  collectDevOnlyNames,
};
