/**
 * pnpm-lock.yaml parser.
 * Uses a line-based state machine instead of a YAML library to avoid
 * third-party dependencies.  Supports lockfile format versions 5, 6, and 9.
 *
 * Format summary:
 *   v5  (pnpm ≤6)  lockfileVersion: 5.x
 *     packages section key:  /name/version:      (scoped: /@scope/name/version:)
 *     dev flag:              dev: true  inside each entry block
 *
 *   v6  (pnpm 7/8) lockfileVersion: '6.0'
 *     packages section key:  /name@version:      (scoped: /@scope/name@version:)
 *     dev flag:              dev: true  inside each entry block
 *
 *   v9  (pnpm 9+)  lockfileVersion: '9.0'
 *     packages section key:  name@version:       (scoped: @scope/name@version:)
 *     peer-dep suffix:       name@version(peer@x)(peer2@y):
 *                            (multiple ()-groups; nested () legal inside each group)
 *     patch suffix:          name@version(patch_hash=…)         optionally
 *                            followed by (peer@x)(peer2@y) suffix
 *     dev flag:              absent from packages; read from importers: section
 *
 * v6/v9 key parsing mirrors pnpm's @pnpm/deps.path package (see
 * deps/path/src/index.ts upstream): use indexOf('@', 1) to find the
 * name/version boundary (handles scoped names and specs that themselves
 * contain '@'), and walk backwards from the trailing ')' counting paren
 * nesting to find the start of the outermost suffix.
 *
 * Non-tarball resolution kinds (directory / git / binary / custom:* per the
 * Resolution union in @pnpm/lockfile.types) are surfaced via
 * parsePnpmDangerousDeps so they appear in the "non-standard sources" panel
 * instead of being sent to the public registry with a junk version string.
 */

/**
 * Walks backwards from a trailing ')' counting paren nesting, mirroring
 * pnpm's indexOfDepPathSuffix in deps/path/src/index.ts.
 *
 * When the open-paren counter returns to zero between two characters, the
 * character at i+1 is the start of the outermost ()-group. If that group is
 * the literal "(patch_hash=…)", any further peer-deps group starting after
 * the patch group is reported separately.
 *
 * @param {string} s - depPath, with v5/v6 leading '/' already stripped
 * @returns {{ peersIndex: number, patchHashIndex: number }} -1 for absent
 */
function indexOfDepPathSuffix(s) {
  if (!s.endsWith(")")) return { peersIndex: -1, patchHashIndex: -1 };
  let open = 1;
  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] === "(") open--;
    else if (s[i] === ")") open++;
    else if (open === 0) {
      if (s.substring(i + 1).startsWith("(patch_hash=")) {
        return {
          patchHashIndex: i + 1,
          peersIndex: s.indexOf("(", i + 2),
        };
      }
      return { patchHashIndex: -1, peersIndex: i + 1 };
    }
  }
  return { peersIndex: -1, patchHashIndex: -1 };
}

/**
 * Removes the outermost peer-deps and patch-hash suffixes from a v6/v9
 * depPath. Mirrors pnpm's removeSuffix() in deps/path/src/index.ts.
 *
 * @param {string} s
 * @returns {string}
 */
function stripPnpmSuffix(s) {
  const { peersIndex, patchHashIndex } = indexOfDepPathSuffix(s);
  if (patchHashIndex !== -1) return s.substring(0, patchHashIndex);
  if (peersIndex !== -1) return s.substring(0, peersIndex);
  return s;
}

/**
 * Parses a package entry key from the packages: section into { name, version }.
 *
 * For v5, name and version are separated by '/' so lastIndexOf('/') is correct.
 * For v6/v9, the boundary is '@' but the spec part can itself contain '@'
 * (npm: aliases, git+ssh URLs), so we use indexOf('@', 1) — same algorithm as
 * pnpm's @pnpm/deps.path parse(). The leading '@' of scoped names is skipped
 * by starting the search at index 1.
 *
 * @param {string} key           - key text with leading/trailing quotes and trailing ':' already stripped
 * @param {number} majorVersion  - parsed major version of the lockfile
 * @returns {{ name: string, version: string }|null} null when the key cannot be parsed
 */
function parsePackageKey(key, majorVersion) {
  let s = key.startsWith("/") ? key.slice(1) : key;

  if (majorVersion <= 5) {
    const lastSlash = s.lastIndexOf("/");
    if (lastSlash === -1) return null;
    return { name: s.slice(0, lastSlash), version: s.slice(lastSlash + 1) };
  }

  s = stripPnpmSuffix(s);

  const atIdx = s.indexOf("@", 1);
  if (atIdx === -1) return null;
  const name = s.slice(0, atIdx);
  const version = s.slice(atIdx + 1);
  if (!name || !version) return null;
  return { name, version };
}

/**
 * Reads the major version number from a pnpm-lock.yaml file.
 * Returns 6 as a conservative default when the field is absent.
 * @param {string} content - raw pnpm-lock.yaml file content
 * @returns {number}
 */
function getPnpmMajorVersion(content) {
  for (const line of content.split("\n")) {
    const m = line.match(/^lockfileVersion:\s*['"]?(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return 6;
}

/**
 * Extracts the value of `type:` from a single-line inline `resolution: {…}`
 * block. Returns null when no type field is present (the typical TarballResolution
 * shape: `resolution: {integrity: …, tarball: …}` has no type field).
 *
 * Matches values with or without surrounding quotes, terminated by ',', '}',
 * whitespace, or end of line — sufficient for the inline form pnpm always emits.
 *
 * @param {string} resolutionLine - the trimmed line beginning with "resolution:"
 * @returns {string|null}
 */
function extractResolutionType(resolutionLine) {
  const m = resolutionLine.match(/[{,]\s*type:\s*['"]?([^,}\s'"]+)/);
  return m ? m[1] : null;
}

/**
 * Parses a pnpm-lock.yaml file and returns a flat, deduplicated list of
 * installed packages.
 *
 * Algorithm:
 *   1. Detect the lockfile major version from the lockfileVersion: field.
 *   2. Walk the packages: section line by line.
 *      - 2-space-indented lines ending with : are package entry keys.
 *      - 4-space-indented "dev: true" marks a package as dev-only (v5/v6).
 *      - 4-space-indented "resolution: {…}" lines are inspected for a `type:`
 *        field; entries whose type is anything other than the implicit
 *        TarballResolution (no type) are filtered out here so non-registry
 *        deps don't reach the resolver. They are surfaced separately via
 *        parsePnpmDangerousDeps.
 *   3. For v9, walk the importers: section to collect direct dep classifications:
 *        prodImporterNames  — names under dependencies / optionalDependencies
 *        devImporterNames   — names under devDependencies
 *      A name is "dev-only" iff it appears in devImporterNames AND not in
 *      prodImporterNames across the union of all importers. This handles the
 *      monorepo case where the same name is dev in one workspace and prod in
 *      another — the package is shipping and must not be excluded.
 *   4. Deduplicate by name@version.
 *   5. Filter out dev-only packages unless includeTests is true.
 *
 * flushEntry() is called both inside the loop (when a new entry starts or a new
 * top-level section begins) and once after the loop ends — that final call is
 * necessary because the very last package entry has no subsequent trigger.
 *
 * @param {string}  content              - raw pnpm-lock.yaml file content
 * @param {boolean} [includeTests=false] - when true, dev packages are included
 * @returns {Array<{ name: string, version: string, resolved: string|null }>}
 */
function parsePnpmLock(content, includeTests = false) {
  const lines = content.split("\n");
  const majorVersion = getPnpmMajorVersion(content);

  /** @type {Map<string, { name: string, version: string, dev: boolean, resolved: string|null }>} */
  const pkgMap = new Map();
  /** @type {Set<string>} direct prod/optional dep names across every importer (v9) */
  const prodImporterNames = new Set();
  /** @type {Set<string>} direct devDependency names across every importer (v9) */
  const devImporterNames = new Set();

  let section = "other";
  let currentEntry = null;
  let nonRegistry = false; // current entry has a non-tarball resolution.type — drop it
  let importerDepType = null; // 'prod' | 'dev' | null (v9 importer sub-section)

  /** Commits currentEntry into pkgMap; deduplicates by name@version only. */
  function flushEntry() {
    if (currentEntry && !nonRegistry) {
      const dedupeKey = `${currentEntry.name}@${currentEntry.version}`;
      if (!pkgMap.has(dedupeKey)) pkgMap.set(dedupeKey, currentEntry);
    }
    currentEntry = null;
    nonRegistry = false;
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === "---") continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      flushEntry();
      importerDepType = null;
      if (trimmed === "packages:") section = "packages";
      else if (trimmed === "importers:") section = "importers";
      else if (trimmed === "snapshots:") section = "snapshots";
      else section = "other";
      continue;
    }

    if (section === "packages") {
      if (indent === 2 && trimmed.endsWith(":")) {
        flushEntry();
        const key = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, "");
        const parsed = parsePackageKey(key, majorVersion);
        currentEntry = parsed ? { ...parsed, dev: false, resolved: null } : null;
      } else if (indent === 4 && currentEntry) {
        if (trimmed === "dev: true") currentEntry.dev = true;
        else if (trimmed === "dev: false") currentEntry.dev = false;
        else if (trimmed.startsWith("resolution:")) {
          const type = extractResolutionType(trimmed);
          // Anything with a `type:` field is a non-TarballResolution variant
          // (directory / git / binary / custom:*) and is not resolvable via
          // registry.npmjs.org — drop it from the resolver pipeline.
          if (type) nonRegistry = true;
          const tarballMatch = trimmed.match(/^resolution:\s*\{[^}]*tarball:\s*([^,}\s]+)/);
          if (tarballMatch) currentEntry.resolved = tarballMatch[1].replace(/^['"]|['"]$/g, "");
        }
      }
      continue;
    }

    if (section === "importers") {
      if (indent === 2 && trimmed.endsWith(":")) {
        importerDepType = null;
      } else if (indent === 4 && trimmed.endsWith(":")) {
        const key = trimmed.slice(0, -1);
        if (key === "dependencies" || key === "optionalDependencies") importerDepType = "prod";
        else if (key === "devDependencies") importerDepType = "dev";
        else importerDepType = null;
      } else if (indent === 6 && importerDepType && trimmed.endsWith(":")) {
        const name = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, "");
        if (importerDepType === "prod") prodImporterNames.add(name);
        else devImporterNames.add(name);
      }
    }
  }

  flushEntry();

  // v9 dev-only set: names that appear in devDependencies of at least one
  // importer AND never appear in dependencies/optionalDependencies of any
  // importer. Matches the cross-workspace semantics: a package that ships
  // prod from any workspace must not be excluded.
  const devOnly = new Set();
  for (const name of devImporterNames) {
    if (!prodImporterNames.has(name)) devOnly.add(name);
  }

  const results = [];
  for (const entry of pkgMap.values()) {
    const isDev = majorVersion >= 9 ? devOnly.has(entry.name) : entry.dev;
    if (!includeTests && isDev) continue;
    results.push({ name: entry.name, version: entry.version, resolved: entry.resolved ?? null });
  }
  return results;
}

/**
 * Extracts non-registry package entries from pnpm-lock.yaml for the
 * "non-standard sources" panel. Walks the packages: section and emits one row
 * per entry whose `resolution:` block carries an explicit `type:` field
 * (directory, git, binary, custom:*). Entries with the implicit
 * TarballResolution shape (no `type:`) are excluded — tarball URLs pointing
 * to non-registry hosts are already handled by the partitionNpmPackages
 * "private registry" pathway and should not be double-reported here.
 *
 * Returns an empty array on parse errors; this is a best-effort helper and
 * must never abort the npm pipeline.
 *
 * @param {string} content - raw pnpm-lock.yaml file content
 * @returns {Array<{ name: string, spec: string, reason: string }>}
 */
function parsePnpmDangerousDeps(content) {
  const lines = content.split("\n");
  const majorVersion = getPnpmMajorVersion(content);

  /** Human-readable reason strings per Resolution.type variant. */
  const REASONS = {
    directory: "local folder (resolution.type: directory)",
    git: "git source (resolution.type: git)",
    binary: "binary download (resolution.type: binary)",
  };

  let section = "other";
  let pending = null; // { name, version } from the most recent key seen
  const seen = new Set();
  const out = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === "---") continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      pending = null;
      section = trimmed === "packages:" ? "packages" : "other";
      continue;
    }

    if (section !== "packages") continue;

    if (indent === 2 && trimmed.endsWith(":")) {
      const key = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, "");
      pending = parsePackageKey(key, majorVersion);
      continue;
    }

    if (indent === 4 && pending && trimmed.startsWith("resolution:")) {
      const type = extractResolutionType(trimmed);
      if (!type) {
        pending = null;
        continue;
      }

      const reason =
        REASONS[type] ?? (type.startsWith("custom:") ? `custom resolver (${type})` : null);

      if (reason) {
        const dedupeKey = `${pending.name}|${pending.version}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          out.push({ name: pending.name, spec: pending.version, reason });
        }
      }
      pending = null;
    }
  }

  return out;
}

export {
  parsePnpmLock,
  parsePnpmDangerousDeps,
  getPnpmMajorVersion,
  parsePackageKey,
  indexOfDepPathSuffix,
  stripPnpmSuffix,
  extractResolutionType,
};
