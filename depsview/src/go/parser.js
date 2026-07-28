/**
 * Node.js-specific wrapper for Go project dependency parsing.
 * Pure string-parsing functions live in parserCore.js (browser-compatible).
 * This module adds file-system operations: reading go.sum / go.mod from a local
 * project directory.
 */

import fs from "node:fs";
import path from "node:path";
import { parseGoSum, parseGoMod, parseGoModReplaces } from "./parserCore.js";
import { partitionGoModules } from "./moduleFilter.js";

/**
 * Detects and parses the Go dependency file in a given project directory.
 * Priority order: go.sum (preferred, full transitive closure) → go.mod (direct + indirect).
 * Returns the parsed dependencies and a label indicating which file was used.
 *
 * Also reads go.mod for `replace` directives: local-path replaces are returned as
 * `dangerousDeps`; fork/alias redirects are informational (`redirectDeps` is not
 * currently forwarded — callers receive only the dangerous subset).
 *
 * Each returned dep has `{ name, version }`; entries parsed from go.mod
 * additionally carry an `indirect` boolean.
 *
 * @param {string} projectPath - absolute path to the Go project root
 * @returns {{
 *   deps: Array<{ name: string, version: string, indirect?: boolean }>,
 *   source: string,
 *   privateCount: number,
 *   privatePkgs: Array<{ name: string, url: string }>,
 *   dangerousDeps: Array<{ name: string, spec: string, reason: string }>
 * }}
 * @throws {Error} when neither go.sum nor go.mod is present
 */
export function parseDependencyFile(projectPath) {
  // Always read go.mod for replace directives when present.
  let dangerousDeps = [];
  const goModPath = path.join(projectPath, "go.mod");
  if (fs.existsSync(goModPath) && !fs.statSync(goModPath).isDirectory()) {
    try {
      dangerousDeps = parseGoModReplaces(fs.readFileSync(goModPath, "utf8")).dangerousDeps;
    } catch {
      /* ignore — replace parsing is best-effort */
    }
  }

  const candidates = [
    { file: "go.sum", parse: parseGoSum },
    { file: "go.mod", parse: parseGoMod },
  ];

  for (const { file, parse } of candidates) {
    const fullPath = path.join(projectPath, file);
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory()) continue;
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const { publicMods, privateCount, privateMods } = partitionGoModules(parse(content));
      return {
        deps: publicMods,
        source: file,
        privateCount,
        privatePkgs: privateMods,
        dangerousDeps,
      };
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
  }

  throw new Error(`No Go dependency file found in ${projectPath}. Looked for: go.sum, go.mod`);
}

/**
 * Reads go.mod (if present) to determine which deps are direct (non-indirect).
 * Used alongside go.sum-based resolution to populate the direct/transitive
 * footer, mirroring how npm uses package.json alongside package-lock.json.
 * Returns an empty Set when go.mod is absent or unparseable.
 * @param {string} dirPath
 * @returns {Set<string>} normalised module paths that are direct deps
 */
export function readDirectNamesFromGoMod(dirPath) {
  try {
    const content = fs.readFileSync(path.join(dirPath, "go.mod"), "utf8");
    const deps = parseGoMod(content);
    return new Set(deps.filter((d) => !d.indirect).map((d) => d.name.toLowerCase()));
  } catch {
    return new Set();
  }
}
