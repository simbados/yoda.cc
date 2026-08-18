/**
 * Detects and parses dependency files from pasted (not fetched) text content.
 *
 * This is the "paste a lockfile/manifest" counterpart to src/github/parser.js:
 * instead of listing a GitHub directory and picking a file by name, the caller
 * already knows the ecosystem (chosen via the UI's ecosystem picker) but has
 * only a raw text blob with no filename to key off of. detectPastedFormat
 * sniffs which of that ecosystem's known formats the content matches;
 * parsePastedDependencies then dispatches to the same parserCore/lockRegistry
 * functions the GitHub and CLI paths already use, returning the identical
 * `{ deps, source, note, warning, privateCount, privatePkgs, dangerousDeps }`
 * shape so the web UI's rendering/resolution pipeline needs no new branching.
 *
 * Pasted mode only ever analyses a single file's contents — there is no
 * multi-file merge step (unlike the GitHub Python path's mergeDeps). To
 * combine multiple files (e.g. pyproject.toml + a separate requirements.txt),
 * use GitHub-URL mode instead.
 *
 * No Node.js imports — loaded directly in the browser via the web/src symlink.
 */

import { NPM_LOCK_FILES } from "./npm/lockRegistry.js";
import { parsePackageJson } from "./npm/parserCore.js";
import { partitionNpmPackages } from "./npm/registryFilter.js";
import { stripTrailingCommas } from "./npm/bunLockParser.js";
import { parseGoSum, parseGoMod, parseGoModReplaces } from "./go/parserCore.js";
import { partitionGoModules } from "./go/moduleFilter.js";
import { parseCargoLock, parseCargoToml } from "./rust/parserCore.js";
import { partitionCargoPackages } from "./rust/crateFilter.js";
import {
  parsePyprojectToml,
  parseSetupCfg,
  parsePipfile,
  parseManifestJson,
  parseRequirementsTxtLines,
  parseDependencyString,
} from "./python/parserCore.js";

/**
 * Returns the first non-blank, trimmed line of a multi-line string, or null
 * when every line is blank.
 * @param {string} content
 * @returns {string|null}
 */
function firstNonBlankLine(content) {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Detects which npm dependency-file format pasted text matches.
 * JSON-shaped formats (package-lock.json, bun.lock, package.json) are
 * distinguished by parsing once (bun.lock's trailing-comma JSONC syntax is
 * tolerated via stripTrailingCommas, a no-op on strict JSON) and inspecting
 * the shape of `packages`/`dependencies`. Non-JSON formats (pnpm-lock.yaml,
 * yarn.lock) are matched by their distinctive header lines.
 * @param {string} content
 * @returns {'package-lock.json'|'bun.lock'|'package.json'|'pnpm-lock.yaml'|'yarn.lock'|null}
 */
function detectNpmFormat(content) {
  let data;
  try {
    data = JSON.parse(stripTrailingCommas(content));
  } catch {
    const firstLine = firstNonBlankLine(content);
    if (firstLine && /^lockfileVersion:\s*['"]?\d/.test(firstLine)) return "pnpm-lock.yaml";
    if (/^# yarn lockfile v1\s*$/m.test(content)) return "yarn.lock";
    if (firstLine === "__metadata:") return "yarn.lock";
    return null;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  if (data.packages && typeof data.packages === "object" && !Array.isArray(data.packages)) {
    const values = Object.values(data.packages);
    if (values.length > 0) return Array.isArray(values[0]) ? "bun.lock" : "package-lock.json";
    // Empty packages map: bun.lock always carries a top-level `workspaces` object.
    return data.workspaces && typeof data.workspaces === "object"
      ? "bun.lock"
      : "package-lock.json";
  }

  const sample = data.dependencies ?? data.devDependencies;
  if (sample && typeof sample === "object" && !Array.isArray(sample)) {
    const sampleValue = Object.values(sample)[0];
    if (sampleValue !== undefined)
      return typeof sampleValue === "object" ? "package-lock.json" : "package.json";
  }

  if (data.name !== undefined || data.version !== undefined) return "package.json";

  return null;
}

/**
 * Detects whether pasted text is a go.mod or go.sum file.
 * go.mod starts with a `module <path>` line; go.sum's line format is rigid
 * enough (`<module> <version>[/go.mod] h1:<hash>`) that every non-blank line
 * must match for the content to be accepted as go.sum.
 * @param {string} content
 * @returns {'go.mod'|'go.sum'|null}
 */
function detectGoFormat(content) {
  const firstLine = firstNonBlankLine(content);
  if (firstLine && /^module\s+\S+/.test(firstLine)) return "go.mod";

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^\S+\s+\S+\s+h1:[A-Za-z0-9+/=]+$/.test(l))) {
    return "go.sum";
  }
  return null;
}

/** Anchored section headers unique to Cargo.toml manifests (never appear in Cargo.lock). */
const CARGO_TOML_HEADERS = [
  /^\[package\]\s*$/m,
  /^\[dependencies\]\s*$/m,
  /^\[dev-dependencies\]\s*$/m,
  /^\[build-dependencies\]\s*$/m,
  /^\[target\..+\]\s*$/m,
];

/**
 * Detects whether pasted text is a Cargo.lock or Cargo.toml file.
 * `[[package]]` (a doubled-bracket array-table) is lockfile-only and never
 * appears in a manifest, so it is checked first and is unambiguous.
 * @param {string} content
 * @returns {'Cargo.lock'|'Cargo.toml'|null}
 */
function detectRustFormat(content) {
  if (/^\[\[package\]\]\s*$/m.test(content)) return "Cargo.lock";
  if (CARGO_TOML_HEADERS.some((re) => re.test(content))) return "Cargo.toml";
  return null;
}

/** Anchored section headers unique to pyproject.toml. */
const PYPROJECT_HEADERS = [
  /^\[project(\.[^\]]*)?\]\s*$/m,
  /^\[tool\.poetry(\.[^\]]*)?\]\s*$/m,
  /^\[build-system\]\s*$/m,
];
/** Anchored section headers unique to Pipfile. */
const PIPFILE_HEADERS = [/^\[\[source\]\]\s*$/m, /^\[packages\]\s*$/m, /^\[dev-packages\]\s*$/m];
/** Anchored section headers unique to setup.cfg. */
const SETUP_CFG_HEADERS = [/^\[metadata\]\s*$/m, /^\[options\]\s*$/m, /^\[options\.[^\]]+\]\s*$/m];
/** PEP 440 / pip comparison operators recognised at the start of a version spec. */
const PEP440_OPERATORS = ["==", ">=", "<=", "!=", "~=", ">", "<"];

/**
 * Returns true when pasted text looks like a plain requirements.txt file.
 * Uses a stricter acceptance gate than the normal (lenient) line parser: a
 * line only counts as a genuine PEP 440 requirement when its version spec is
 * absent or starts with a real comparison operator. This guards against a
 * false positive from e.g. a bare go.mod line (`github.com/x/y v1.2.3`),
 * which the lenient parseDependencyString would otherwise partially match.
 * Accepts the format only when at least one line passes the strict gate and
 * passing lines are a majority of candidate (non-blank, non-comment,
 * non-flag) lines.
 * @param {string} content
 * @returns {boolean}
 */
function looksLikeRequirementsTxt(content) {
  let candidateCount = 0;
  let strictMatchCount = 0;

  for (let line of content.split("\n")) {
    line = line.split("#")[0].trim();
    while (line.endsWith("\\")) line = line.slice(0, -1).trim();
    if (!line || line.startsWith("-")) continue;
    candidateCount++;

    const dep = parseDependencyString(line);
    if (!dep) continue;
    if (dep.versionSpec === null || PEP440_OPERATORS.some((op) => dep.versionSpec.startsWith(op))) {
      strictMatchCount++;
    }
  }

  return candidateCount > 0 && strictMatchCount > 0 && strictMatchCount >= candidateCount / 2;
}

/**
 * Detects which Python dependency-file format pasted text matches.
 * @param {string} content
 * @returns {'manifest.json'|'pyproject.toml'|'Pipfile'|'setup.cfg'|'requirements.txt'|null}
 */
function detectPythonFormat(content) {
  try {
    const data = JSON.parse(content);
    if (data && Array.isArray(data.requirements)) return "manifest.json";
  } catch {
    // Not JSON — fall through to the TOML/INI/plain-text checks below.
  }

  if (PYPROJECT_HEADERS.some((re) => re.test(content))) return "pyproject.toml";
  if (PIPFILE_HEADERS.some((re) => re.test(content))) return "Pipfile";
  if (SETUP_CFG_HEADERS.some((re) => re.test(content))) return "setup.cfg";

  return looksLikeRequirementsTxt(content) ? "requirements.txt" : null;
}

/**
 * Sniffs pasted text against the known formats for one ecosystem and returns
 * the matching canonical filename, or null when nothing matches. Pure and
 * synchronous. Scoped to the caller-supplied ecosystem, so there is no
 * cross-ecosystem ambiguity to resolve (the ecosystem is already known from
 * the UI's ecosystem picker).
 * @param {string} content
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @returns {string|null}
 */
export function detectPastedFormat(content, ecosystem) {
  if (ecosystem === "npm") return detectNpmFormat(content);
  if (ecosystem === "go") return detectGoFormat(content);
  if (ecosystem === "rust") return detectRustFormat(content);
  if (ecosystem === "python") return detectPythonFormat(content);
  return null;
}

/**
 * Parses pasted npm content once its format has been detected.
 * Mirrors parseGithubNpmDependencies's dispatch: lock formats go through
 * NPM_LOCK_FILES + partitionNpmPackages; package.json goes through
 * parsePackageJson directly.
 * @param {string} content
 * @param {string} format
 * @param {boolean} includeTests
 * @returns {{ deps: Array, source: string, note: string|null, warning: string|null, privateCount: number, privatePkgs: Array, dangerousDeps: Array }}
 */
function parsePastedNpm(content, format, includeTests) {
  const lockEntry = NPM_LOCK_FILES.find((e) => e.filename === format);
  if (lockEntry) {
    const rawDeps = lockEntry.parse(content, includeTests);
    const note = lockEntry.getNote(content);
    const warning = lockEntry.getWarning(content);
    const dangerousDeps = lockEntry.getDangerousDeps
      ? lockEntry.getDangerousDeps(content, includeTests)
      : [];
    const { publicPkgs, privateCount, privatePkgs } = partitionNpmPackages(rawDeps);
    return {
      deps: publicPkgs,
      source: format,
      note,
      warning,
      privateCount,
      privatePkgs,
      dangerousDeps,
    };
  }

  const { deps, dangerousDeps } = parsePackageJson(content, includeTests);
  return {
    deps,
    source: "package.json",
    note: null,
    warning: null,
    privateCount: 0,
    privatePkgs: [],
    dangerousDeps,
  };
}

/**
 * Parses pasted Go content once its format has been detected. Mirrors
 * parseGithubGoDependencies's dispatch: go.mod `replace` directives are only
 * inspected when go.mod is the source (no extra fetch needed, unlike GitHub
 * mode, since there is nothing else to fetch here either).
 * @param {string} content
 * @param {string} format
 * @returns {{ deps: Array, source: string, note: null, warning: null, privateCount: number, privatePkgs: Array, dangerousDeps: Array }}
 */
function parsePastedGo(content, format) {
  const rawDeps = format === "go.sum" ? parseGoSum(content) : parseGoMod(content);
  const { publicMods, privateCount, privateMods } = partitionGoModules(rawDeps);
  const dangerousDeps = format === "go.mod" ? parseGoModReplaces(content).dangerousDeps : [];
  return {
    deps: publicMods,
    source: format,
    note: null,
    warning: null,
    privateCount,
    privatePkgs: privateMods,
    dangerousDeps,
  };
}

/**
 * Parses pasted Rust content once its format has been detected. Mirrors
 * parseGithubRustDependencies's dispatch: Cargo.lock never surfaces
 * dangerousDeps (would require a second fetch of Cargo.toml, which pasted
 * mode has no way to obtain either).
 * @param {string} content
 * @param {string} format
 * @param {boolean} includeTests
 * @returns {{ deps: Array, source: string, note: null, warning: null, privateCount: number, privatePkgs: Array, dangerousDeps: Array }}
 */
function parsePastedRust(content, format, includeTests) {
  if (format === "Cargo.lock") {
    const { publicPkgs, privateCount, privatePkgs } = partitionCargoPackages(
      parseCargoLock(content),
    );
    return {
      deps: publicPkgs,
      source: "Cargo.lock",
      note: null,
      warning: null,
      privateCount,
      privatePkgs,
      dangerousDeps: [],
    };
  }
  const { deps, dangerousDeps } = parseCargoToml(content, includeTests);
  return {
    deps,
    source: "Cargo.toml",
    note: null,
    warning: null,
    privateCount: 0,
    privatePkgs: [],
    dangerousDeps,
  };
}

/**
 * Parses pasted Python content once its format has been detected.
 * requirements.txt is parsed via parseRequirementsTxtLines (no include
 * resolution possible from pasted text); a non-empty skippedIncludes list is
 * surfaced as a note rather than silently dropped. The other formats have no
 * filesystem/repo dependency and are parsed identically to the GitHub/CLI paths.
 * @param {string} content
 * @param {string} format
 * @param {boolean} includeTests
 * @returns {{ deps: Array, source: string, note: string|null, warning: null, privateCount: number, privatePkgs: Array, dangerousDeps: Array }}
 */
function parsePastedPython(content, format, includeTests) {
  if (format === "requirements.txt") {
    const { deps, dangerousDeps, skippedIncludes } = parseRequirementsTxtLines(
      content,
      includeTests,
    );
    const note =
      skippedIncludes.length > 0
        ? `Skipped ${skippedIncludes.length} '-r'/'--requirement' include line${skippedIncludes.length === 1 ? "" : "s"} — file includes cannot be resolved from pasted text (no repository to fetch from). Paste each included file's contents together, or use GitHub URL mode instead.`
        : null;
    return {
      deps,
      source: "requirements.txt",
      note,
      warning: null,
      privateCount: 0,
      privatePkgs: [],
      dangerousDeps,
    };
  }
  if (format === "pyproject.toml") {
    return {
      deps: parsePyprojectToml(content, includeTests),
      source: "pyproject.toml",
      note: null,
      warning: null,
      privateCount: 0,
      privatePkgs: [],
      dangerousDeps: [],
    };
  }
  if (format === "setup.cfg") {
    return {
      deps: parseSetupCfg(content),
      source: "setup.cfg",
      note: null,
      warning: null,
      privateCount: 0,
      privatePkgs: [],
      dangerousDeps: [],
    };
  }
  if (format === "Pipfile") {
    return {
      deps: parsePipfile(content, includeTests),
      source: "Pipfile",
      note: null,
      warning: null,
      privateCount: 0,
      privatePkgs: [],
      dangerousDeps: [],
    };
  }
  // manifest.json
  return {
    deps: parseManifestJson(content),
    source: "manifest.json",
    note: null,
    warning: null,
    privateCount: 0,
    privatePkgs: [],
    dangerousDeps: [],
  };
}

/**
 * Detects the format of pasted text within the given ecosystem, then parses
 * it via the matching parserCore/lockRegistry function. Returns the same
 * shape as parseGithubNpmDependencies / parseGithubGoDependencies /
 * parseGithubRustDependencies / parseGithubDependencies:
 * `{ deps, source, note, warning, privateCount, privatePkgs, dangerousDeps }`.
 *
 * `source` is always the exact canonical filename (e.g. 'package-lock.json',
 * 'go.mod') — never a "(pasted)"-suffixed variant — because callers rely on
 * it to detect lock-file sources (NPM_LOCK_FILENAMES.has(source), etc.) the
 * same way the GitHub and CLI paths do.
 *
 * Declared `async` for signature symmetry with the parseGithub*Dependencies
 * functions callers already await uniformly; the body itself is synchronous
 * (no network or filesystem access).
 *
 * @param {string} content
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @param {{ includeTests?: boolean }} [options]
 * @returns {Promise<{
 *   deps: Array, source: string, note: string|null, warning: string|null,
 *   privateCount: number, privatePkgs: Array, dangerousDeps: Array
 * }>}
 * @throws {Error} when the content doesn't match any known format for the ecosystem
 */
export async function parsePastedDependencies(content, ecosystem, options = {}) {
  const { includeTests = false } = options;
  const format = detectPastedFormat(content, ecosystem);
  if (!format) {
    throw new Error(`Could not recognise this as a supported ${ecosystem} dependency file format.`);
  }

  if (ecosystem === "npm") return parsePastedNpm(content, format, includeTests);
  if (ecosystem === "go") return parsePastedGo(content, format);
  if (ecosystem === "rust") return parsePastedRust(content, format, includeTests);
  return parsePastedPython(content, format, includeTests);
}
