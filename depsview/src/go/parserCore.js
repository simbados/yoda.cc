/**
 * Pure string parsers for Go dependency files.
 * No filesystem or network access — safe to use in browser environments too.
 */

/**
 * Lowercases a Go module path for use as a Map key.
 * Go module paths are case-sensitive, but lowercase comparison is sufficient
 * for deduplication and result lookup since the proxy handles canonical encoding.
 * @param {string} name
 * @returns {string}
 */
export function normalizeGoModulePath(name) {
  return name.toLowerCase();
}

/**
 * Parses a go.sum file into a deduplicated list of module + version pairs.
 *
 * Each module version in go.sum appears as up to two lines:
 *   <module> <version> <hash>          — hash of the module zip (kept)
 *   <module> <version>/go.mod <hash>   — hash of just the go.mod file (skipped)
 *
 * Only the zip-hash entries correspond to modules actually present in the build;
 * the `/go.mod`-suffixed entries can include modules referenced only via
 * lazy-loading go.mod traversal that never made it into the final build graph.
 *
 * @param {string} content
 * @returns {Array<{ name: string, version: string }>}
 */
export function parseGoSum(content) {
  const seen = new Set();
  const deps = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const [name, versionField] = parts;
    if (versionField.endsWith('/go.mod')) continue;

    const key = `${name}@${versionField}`;
    if (seen.has(key)) continue;
    seen.add(key);

    deps.push({ name, version: versionField });
  }

  return deps;
}

/**
 * Parses a go.mod file into a list of required module dependencies.
 *
 * Handles both block-form (`require ( ... )`) and single-line (`require x v1`)
 * directives. Lines marked with `// indirect` are flagged on the returned entry
 * so the caller can distinguish direct deps from those managed by the Go toolchain.
 * Skips module, go, toolchain, replace, exclude, and retract directives.
 *
 * @param {string} content
 * @returns {Array<{ name: string, version: string, indirect: boolean }>}
 */
function unquote(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseGoMod(content) {
  const deps = [];
  let inRequireBlock = false;

  for (const rawLine of content.split('\n')) {
    // Detect indirect annotation before stripping comments
    const commentIdx = rawLine.indexOf('//');
    const isIndirect = commentIdx !== -1 && /\bindirect\b/.test(rawLine.slice(commentIdx));
    const line = (commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        deps.push({ name: unquote(parts[0]), version: unquote(parts[1]), indirect: isIndirect });
      }
      continue;
    }

    if (/^require\s*\(/.test(line)) {
      inRequireBlock = true;
      continue;
    }

    if (/^require\s+\S/.test(line)) {
      const rest = line.replace(/^require\s+/, '');
      const parts = rest.split(/\s+/);
      if (parts.length >= 2) {
        deps.push({ name: unquote(parts[0]), version: unquote(parts[1]), indirect: isIndirect });
      }
    }
  }

  return deps;
}
