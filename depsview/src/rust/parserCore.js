/**
 * Pure string parsers for Rust / Cargo dependency files.
 * No filesystem or network access — safe to load in browser environments via the
 * web/src symlink. Implements a minimal TOML reader scoped to what Cargo.toml and
 * Cargo.lock actually use (top-level tables, [[array]] tables, scalar string and
 * integer values, single-line and multi-line arrays of strings, single-line
 * inline tables). Full TOML compliance is intentionally out of scope.
 *
 * References:
 *   https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html
 *   https://doc.rust-lang.org/cargo/reference/manifest.html
 *   https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
 *   https://doc.rust-lang.org/cargo/reference/pkgid-spec.html
 */

/**
 * Normalises a crate name for use as a Map key (lowercase, runs of `-`/`_`
 * collapsed to a single `-`). crates.io treats `foo-bar` and `foo_bar` as
 * distinct crates, but normalisation here is only ever used for deduplication
 * within a single run, so a slightly tolerant key is safe.
 * @param {string} name
 * @returns {string}
 */
export function normalizeCrateName(name) {
  return name.toLowerCase().replace(/[-_]+/g, '-');
}

/**
 * Strips a single trailing `#` comment from a TOML line, while leaving `#`
 * characters that sit inside double-quoted strings untouched. Quote tracking is
 * single-pass and does not honour escapes inside basic strings — sufficient for
 * Cargo files where comments after string values are exceedingly rare.
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

/**
 * Unwraps a TOML basic (double-quoted) or literal (single-quoted) string.
 * For anything that does not look like a quoted string, returns the trimmed
 * input unchanged. No escape processing is performed; Cargo file string values
 * (crate names, version requirements, URLs, paths) never need it in practice.
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0], last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Splits an inline-table body or array body into top-level comma-separated
 * tokens while respecting nested `[]` / `{}` brackets and double-quoted strings.
 * Empty tokens that result from a trailing comma are filtered out.
 * @param {string} body
 * @returns {string[]}
 */
function splitTopLevel(body) {
  const out = [];
  let depthBrace = 0, depthBracket = 0, inStr = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' && body[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '[') depthBracket++;
    else if (c === ']') depthBracket--;
    else if (c === ',' && depthBrace === 0 && depthBracket === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim() !== '') out.push(tail);
  return out;
}

/**
 * Parses the body of an inline table (the text inside `{ ... }`) into a flat
 * `{ key: rawValueString }` map. Values keep their TOML literal form so the
 * caller can decide whether to unquote them, parse them as arrays, etc.
 * @param {string} body - text between the surrounding braces (braces excluded)
 * @returns {Record<string, string>}
 */
function parseInlineTable(body) {
  const fields = {};
  for (const token of splitTopLevel(body)) {
    const eqIdx = token.indexOf('=');
    if (eqIdx === -1) continue;
    const key = token.slice(0, eqIdx).trim();
    const val = token.slice(eqIdx + 1).trim();
    if (key) fields[key] = val;
  }
  return fields;
}

/**
 * Joins a TOML multi-line array literal that begins on `firstLine` (which
 * already contains the opening `[`) by consuming subsequent lines from
 * `lines` starting at `startIdx`. Returns the concatenated body (everything
 * after the opening `[` up to and excluding the matching `]`) plus the line
 * index of the closing bracket. When the array is single-line, returns the
 * inner body and the same start index.
 *
 * The joiner is bracket-depth aware so nested arrays inside inline tables do
 * not terminate the outer scan prematurely.
 *
 * @param {string} firstLine    - the first physical line, expected to contain `[`
 * @param {string[]} lines      - the full line array
 * @param {number}  startIdx    - index of `firstLine` in `lines`
 * @returns {{ body: string, endIdx: number }}
 */
function joinMultilineArray(firstLine, lines, startIdx) {
  const openIdx = firstLine.indexOf('[');
  if (openIdx === -1) return { body: '', endIdx: startIdx };

  let depthBracket = 0, depthBrace = 0, inStr = false;
  let collected = '';
  for (let i = startIdx; i < lines.length; i++) {
    const line = i === startIdx ? firstLine.slice(openIdx + 1) : lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"' && line[j - 1] !== '\\') inStr = !inStr;
      if (!inStr) {
        if (c === '[') depthBracket++;
        else if (c === ']') {
          if (depthBracket === 0 && depthBrace === 0) {
            collected += line.slice(0, j);
            return { body: collected, endIdx: i };
          }
          depthBracket--;
        } else if (c === '{') depthBrace++;
        else if (c === '}') depthBrace--;
      }
    }
    collected += line + '\n';
  }
  return { body: collected, endIdx: lines.length - 1 };
}

/**
 * Recognised section header in a TOML file: returns the trimmed header path
 * and whether it was an `[[array of tables]]` header. Returns null when the
 * line is not a header.
 * @param {string} line - already trimmed
 * @returns {{ path: string, isArray: boolean }|null}
 */
function parseHeader(line) {
  const arr = line.match(/^\[\[(.+?)\]\]\s*$/);
  if (arr) return { path: arr[1].trim(), isArray: true };
  const tbl = line.match(/^\[(.+?)\]\s*$/);
  if (tbl) return { path: tbl[1].trim(), isArray: false };
  return null;
}

/**
 * Returns true when the TOML section path corresponds to a Cargo dependency
 * table. `includeDev` controls whether `[dev-dependencies]` (and the same name
 * under any `[target.<cfg>.…]` prefix) are included.
 *
 * Recognised tables:
 *   - [dependencies]
 *   - [build-dependencies]
 *   - [dev-dependencies]                       (when includeDev)
 *   - [target.<cfg>.dependencies]
 *   - [target.<cfg>.build-dependencies]
 *   - [target.<cfg>.dev-dependencies]          (when includeDev)
 *
 * The `<cfg>` portion is matched lazily so quoted target triples like
 * `"cfg(unix)"` are handled without a TOML-quoted-key parser.
 *
 * @param {string} sectionPath
 * @param {boolean} includeDev
 * @returns {{ kind: 'normal'|'build'|'dev' }|null}
 */
function classifyDependencyTable(sectionPath, includeDev) {
  const tail = sectionPath.replace(/^target\.[^.]+(\.[^.]+)*\./i, '');
  if (tail === 'dependencies')        return { kind: 'normal' };
  if (tail === 'build-dependencies')  return { kind: 'build'  };
  if (tail === 'dev-dependencies' && includeDev) return { kind: 'dev' };
  return null;
}

/**
 * Returns true when a Cargo dependency-table entry should be treated as a
 * non-standard source rather than a public crates.io lookup. Recognises `git`,
 * `path`, and (alternative) `registry` keys inside the inline table.
 *
 * `workspace = true` is **not** dangerous — the resolved version comes from the
 * root workspace `[workspace.dependencies]` table, but it is still a crates.io
 * reference. We surface workspace entries as a soft "skip" rather than a flag.
 *
 * @param {Record<string,string>} fields - already-parsed inline-table fields
 * @returns {string|null} reason string when dangerous; null otherwise
 */
function inlineTableDangerReason(fields) {
  if (fields.git      !== undefined) return 'git dependency';
  if (fields.path     !== undefined) return 'path dependency';
  if (fields.registry !== undefined) return 'alternative registry';
  return null;
}

/**
 * Parses a Cargo.toml manifest into a list of declared dependencies plus a
 * dangerousDeps array for non-registry entries (`git = ...`, `path = ...`,
 * `registry = ...`).
 *
 * Behaviour:
 *   - `[dependencies]` and `[build-dependencies]` are always included.
 *   - `[dev-dependencies]` is included only when `includeDev` is true.
 *   - `[target.<cfg>.dependencies]` tables are honoured the same way.
 *   - `[workspace.dependencies]` is read so workspace-inherited deps in the
 *     root manifest still contribute crates to the resolution set.
 *   - `package = "foo"` (renamed deps) resolves the on-registry crate name
 *     from the `package` key; the key itself becomes the local alias.
 *   - `workspace = true` inline-table entries are skipped at this layer
 *     because the actual version lives in the workspace root manifest, which
 *     the caller may or may not have available.
 *
 * @param {string} content
 * @param {boolean} [includeDev=false]
 * @returns {{
 *   deps: Array<{ name: string, versionSpec: string|null }>,
 *   dangerousDeps: Array<{ name: string, spec: string, reason: string }>
 * }}
 */
export function parseCargoToml(content, includeDev = false) {
  const lines = content.split('\n');
  const deps          = [];
  const dangerousDeps = [];
  const seen          = new Set();

  let currentDepKind = null; // 'normal' | 'build' | 'dev' | null
  let inWorkspaceDepTable = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).replace(/\r$/, '');
    const line = raw.trim();
    if (!line) continue;

    const header = parseHeader(line);
    if (header) {
      currentDepKind = null;
      inWorkspaceDepTable = false;
      if (header.isArray) continue;
      const cls = classifyDependencyTable(header.path, includeDev);
      if (cls) currentDepKind = cls.kind;
      else if (header.path === 'workspace.dependencies') inWorkspaceDepTable = true;
      continue;
    }

    if (currentDepKind === null && !inWorkspaceDepTable) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    let value    = line.slice(eqIdx + 1).trim();
    if (!rawKey) continue;
    const localName = unquote(rawKey);

    // Multi-line inline tables / arrays — rejoin until balanced.
    if (value.startsWith('{') && !value.endsWith('}')) {
      const joined = joinMultilineArray(value, lines, i);
      // joinMultilineArray treats `[` as the opener; for `{` use a small loop.
      let depth = 0, inStr = false, end = -1;
      let collected = '';
      for (let li = i; li < lines.length; li++) {
        const lineText = li === i ? value : lines[li];
        for (let j = 0; j < lineText.length; j++) {
          const c = lineText[j];
          if (c === '"' && lineText[j - 1] !== '\\') inStr = !inStr;
          if (inStr) continue;
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { collected += lineText.slice(0, j + 1); end = li; break; }
          }
        }
        if (end !== -1) break;
        collected += lineText + '\n';
      }
      if (end !== -1) { value = collected; i = end; }
      // Silence unused-warning from joined; the bracket scanner above is canonical.
      void joined;
    }

    let versionSpec = null;
    let onRegistryName = localName;
    let danger = null;

    if (value.startsWith('"') || value.startsWith("'")) {
      versionSpec = unquote(value);
    } else if (value.startsWith('{') && value.endsWith('}')) {
      const fields = parseInlineTable(value.slice(1, -1));

      // workspace = true means inherit from [workspace.dependencies] — skip
      // here; the workspace table itself, if visible, will provide the entry.
      if (fields.workspace === 'true') continue;

      if (fields.package) onRegistryName = unquote(fields.package);
      if (fields.version) versionSpec    = unquote(fields.version);
      danger = inlineTableDangerReason(fields);
    } else {
      continue;
    }

    if (danger) {
      dangerousDeps.push({ name: onRegistryName, spec: `${rawKey} = ${value}`, reason: danger });
      continue;
    }

    const dedupKey = `${normalizeCrateName(onRegistryName)}|${currentDepKind ?? 'workspace'}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    deps.push({ name: onRegistryName, versionSpec: versionSpec ?? null });
  }

  return { deps, dangerousDeps };
}

/**
 * Source URL prefixes that identify the public crates.io registry. Cargo
 * historically uses the git-protocol URL and, since 1.70, the sparse-protocol
 * URL. The sparse form is sometimes rewritten by Cargo when migrating
 * lockfiles, but both forms appear in the wild and both are treated as
 * "public registry" here.
 */
const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

/**
 * Returns true when a Cargo.lock `source` field value points at the public
 * crates.io registry (either the git or sparse protocol URL).
 * @param {string|null|undefined} source
 * @returns {boolean}
 */
export function isCratesIoSource(source) {
  if (!source) return false;
  return CRATES_IO_SOURCES.has(source);
}

/**
 * Parses a Cargo.lock file into a deduplicated list of `[[package]]` entries.
 *
 * Each returned entry carries the package `name`, `version`, and the raw
 * `source` string (or null when omitted, which Cargo does for workspace
 * members and path-only crates — i.e. the project under analysis itself).
 *
 * Packages with `source === null` are kept in the result so the caller can
 * decide whether to filter them out (the partitioner does — workspace
 * members are not registry-resolvable).
 *
 * @param {string} content
 * @returns {Array<{ name: string, version: string, source: string|null }>}
 */
export function parseCargoLock(content) {
  const lines = content.split('\n');
  const packages = [];

  let inPackage = false;
  let current = null;

  /** Pushes the current package once its block ends, deduplicating on name@version@source. */
  const seen = new Set();
  const flush = () => {
    if (!current) return;
    if (!current.name || !current.version) { current = null; return; }
    const key = `${current.name}@${current.version}@${current.source ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      packages.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).replace(/\r$/, '');
    const line = raw.trim();
    if (!line) continue;

    const header = parseHeader(line);
    if (header) {
      flush();
      inPackage = header.isArray && header.path === 'package';
      if (inPackage) current = { name: '', version: '', source: null };
      continue;
    }

    if (!inPackage || !current) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // We only care about scalar fields. `dependencies = [ ... ]` may span
    // multiple lines; jump past it without consuming the closing `]` twice.
    if (key === 'dependencies' && value.startsWith('[') && !value.endsWith(']')) {
      const { endIdx } = joinMultilineArray(value, lines, i);
      i = endIdx;
      continue;
    }
    if (key === 'dependencies') continue;

    if (key === 'name')    current.name    = unquote(value);
    else if (key === 'version') current.version = unquote(value);
    else if (key === 'source')  current.source  = unquote(value);
    // `checksum` and other fields are ignored.
  }
  flush();

  return packages;
}
