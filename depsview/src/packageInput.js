/**
 * Package input parser.
 * Converts a raw user-supplied package identifier into a { name, version } pair
 * suitable for passing to the per-ecosystem dep resolvers.
 */

/**
 * Parses a raw npm package identifier into { name, version }.
 * Handles scoped packages (e.g. "@babel/core") by skipping the leading "@" when
 * searching for the version separator.
 * Returns version 'latest' when no version is specified.
 * @param {string} input - trimmed user input, e.g. "eslint", "eslint@8", "@babel/core@7.24"
 * @returns {{ name: string, version: string }}
 */
function parseNpm(input) {
  const searchFrom = input.startsWith("@") ? 1 : 0;
  const atIdx = input.indexOf("@", searchFrom);
  if (atIdx === -1) return { name: input, version: "latest" };
  const version = input.slice(atIdx + 1);
  return { name: input.slice(0, atIdx), version: version || "latest" };
}

/**
 * Parses a raw Python package identifier into { name, version }.
 * Recognises PEP 440 specifier operators (==, >=, <=, !=, ~=, >, <).
 * Returns version null when no specifier is present, which callers treat as "latest stable".
 * @param {string} input - trimmed user input, e.g. "requests", "requests==2.31.0", "requests>=2.0"
 * @returns {{ name: string, version: string|null }}
 */
function parsePython(input) {
  const match = input.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|>=|<=|!=|~=|>|<)\s*(.+)$/);
  if (!match) return { name: input, version: null };
  return { name: match[1], version: `${match[2]}${match[3]}` };
}

/**
 * Parses a raw Go module identifier into { name, version }.
 * The version is separated from the module path by "@".
 * Returns version 'latest' when no version is specified.
 * @param {string} input - trimmed user input, e.g. "github.com/gin-gonic/gin", "github.com/gin-gonic/gin@v1.9.1"
 * @returns {{ name: string, version: string }}
 */
function parseGo(input) {
  const atIdx = input.indexOf("@");
  if (atIdx === -1) return { name: input, version: "latest" };
  const version = input.slice(atIdx + 1);
  return { name: input.slice(0, atIdx), version: version || "latest" };
}

/**
 * Parses a raw Rust crate identifier into { name, version }.
 * The version requirement is separated from the crate name by "@" (e.g.
 * "tokio@1.35", "clap@^4"). The version part may be any Cargo version
 * requirement, which the resolver interprets with Cargo SemVer rules.
 * Returns version 'latest' when no version is specified.
 * @param {string} input - trimmed user input, e.g. "serde", "tokio@1", "clap@^4.5"
 * @returns {{ name: string, version: string }}
 */
function parseRust(input) {
  const atIdx = input.indexOf("@");
  if (atIdx === -1) return { name: input, version: "latest" };
  const version = input.slice(atIdx + 1);
  return { name: input.slice(0, atIdx), version: version || "latest" };
}

/**
 * Parses a raw user-supplied package identifier into { name, version } for the given ecosystem.
 * Delegates to the ecosystem-specific parser (parseNpm, parsePython, parseGo, parseRust).
 *
 * For npm, go, and rust, version is 'latest' when not specified.
 * For python, version is null when no PEP 440 specifier is present (resolves to latest stable).
 *
 * @param {string} raw - raw user input, e.g. "eslint@8", "requests>=2.0", "github.com/gin-gonic/gin@latest"
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @returns {{ name: string, version: string|null }}
 */
export function parsePackageInput(raw, ecosystem) {
  const input = raw.trim();
  if (ecosystem === "npm") return parseNpm(input);
  if (ecosystem === "go") return parseGo(input);
  if (ecosystem === "rust") return parseRust(input);
  return parsePython(input);
}
