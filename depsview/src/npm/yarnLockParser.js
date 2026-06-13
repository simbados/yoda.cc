/**
 * yarn.lock parser — supports Yarn Classic (v1) and Yarn Berry (v2+).
 *
 * Classic (v1): identified by "# yarn lockfile v1". Custom key-space-value syntax:
 *   lodash@^4.17.0, lodash@^4.0.0:  ← unquoted/quoted header, no protocol prefix
 *     version "4.17.21"              ← space-separated, value quoted
 *     resolved "https://registry.yarnpkg.com/..."
 *   Private packages detectable via non-public resolved URLs.
 *
 * Berry (v2+): identified by "__metadata:". Standard YAML syntax:
 *   "lodash@npm:^4.17.0":            ← quoted, explicit @npm: protocol
 *     version: 4.17.21               ← YAML colon-separated
 *     resolution: "lodash@npm:4.17.21"  ← identifier only, NO tarball URL
 *     linkType: hard                  ← hard = installed, soft = workspace symlink
 *   Registry config lives in .yarnrc.yml — NOT in the lockfile. Private packages
 *   cannot be detected; see lockRegistry.js getNote for the privacy warning.
 *
 * Neither format flags packages as dev-only. includeTests is accepted for interface
 * consistency but has no effect — all installed packages are returned.
 */

/**
 * Returns 1 for Yarn Classic or 2 for Yarn Berry.
 * @param {string} content - raw yarn.lock file content
 * @returns {1|2}
 */
function getYarnMajorVersion(content) {
  if (content.includes('# yarn lockfile v1')) return 1;
  if (content.includes('__metadata:')) return 2;
  return 1;
}

/**
 * Extracts the package name from a Classic specifier like `lodash@^4.17.0` or
 * `"@scope/name@^1.0.0"`. Strips surrounding quotes, then splits on the last `@`.
 * Returns null when no valid separator is found.
 * @param {string} spec
 * @returns {string|null}
 */
function parseClassicSpecifier(spec) {
  const s = spec.replace(/^["']|["']$/g, '').trim();
  const i = s.lastIndexOf('@');
  return i > 0 ? s.slice(0, i) : null;
}

/**
 * Extracts the package name from a Berry specifier like `"@scope/name@npm:^1.0.0"`.
 * Only handles the @npm: protocol; returns null for @workspace:, @file:, @patch:, etc.
 * @param {string} spec
 * @returns {string|null}
 */
function parseBerrySpecifier(spec) {
  const s = spec.replace(/^["']|["']$/g, '').trim();
  const i = s.indexOf('@npm:');
  return i > 0 ? s.slice(0, i) : null;
}

/**
 * Parses a yarn.lock file (Classic v1 or Berry v2+) and returns a flat, deduplicated
 * list of installed packages.
 *
 * Uses a single line-by-line state machine for both formats. Format-specific
 * differences are handled inline via the `isBerry` flag:
 *   - Header parsing: Classic uses parseClassicSpecifier, Berry uses parseBerrySpecifier
 *     and skips the __metadata: block.
 *   - Field syntax: Classic uses `key "value"`, Berry uses `key: value`.
 *   - Berry skips linkType: soft entries (workspace symlinks, local packages).
 *   - Berry has no tarball URL; resolved is always null.
 *
 * flushEntry() is called both on each new header and after the loop ends — the final
 * entry has no subsequent header to trigger it otherwise.
 *
 * @param {string}  content              - raw yarn.lock file content
 * @param {boolean} [includeTests=false] - accepted for interface consistency; has no effect
 * @returns {Array<{ name: string, version: string, resolved: string|null }>}
 */
function parseYarnLock(content, includeTests = false) { // eslint-disable-line no-unused-vars
  const isBerry = getYarnMajorVersion(content) === 2;
  const lines   = content.split('\n');

  /** @type {Map<string, { name: string, version: string, resolved: string|null }>} */
  const pkgMap = new Map();

  let currentName     = null;
  let currentVersion  = null;
  let currentResolved = null; // Classic only; Berry always null
  let currentLinkType = null; // Berry only

  function flushEntry() {
    if (currentName && currentVersion) {
      if (!isBerry || currentLinkType === 'hard') {
        const key = `${currentName}@${currentVersion}`;
        if (!pkgMap.has(key)) {
          pkgMap.set(key, { name: currentName, version: currentVersion, resolved: currentResolved });
        }
      }
    }
    currentName = currentVersion = currentResolved = currentLinkType = null;
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      flushEntry();
      if (trimmed.endsWith(':')) {
        const header    = trimmed.slice(0, -1);
        const firstSpec = header.split(', ')[0];
        currentName = isBerry
          ? (trimmed !== '__metadata:' ? parseBerrySpecifier(firstSpec) : null)
          : parseClassicSpecifier(firstSpec);
      }
    } else if (indent === 2 && currentName) {
      if (isBerry) {
        const mVer  = trimmed.match(/^version:\s+(\S+)/);
        if (mVer) { currentVersion  = mVer[1].replace(/^["']|["']$/g, ''); continue; }
        const mLink = trimmed.match(/^linkType:\s+(\S+)/);
        if (mLink)  { currentLinkType = mLink[1]; }
      } else {
        const mVer = trimmed.match(/^version "([^"]+)"/);
        if (mVer) { currentVersion = mVer[1]; continue; }
        const mRes = trimmed.match(/^resolved "([^"]+)"/);
        if (mRes) {
          const url      = mRes[1];
          const hashIdx  = url.indexOf('#');
          const stripped = hashIdx === -1 ? url : url.slice(0, hashIdx);
          // Only accept https:// URLs — rejects file:, git+, and other schemes.
          // Normalise registry.yarnpkg.com → registry.npmjs.org: the two are
          // equivalent (yarnpkg.com is a CDN alias). Custom private registries
          // would require parsing .yarnrc.yml which is not yet supported.
          currentResolved = stripped.startsWith('https://')
            ? stripped.replace('https://registry.yarnpkg.com/', 'https://registry.npmjs.org/')
            : null;
        }
      }
    }
  }

  flushEntry();
  return Array.from(pkgMap.values());
}

export { parseYarnLock, getYarnMajorVersion, parseClassicSpecifier, parseBerrySpecifier };
