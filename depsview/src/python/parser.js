/**
 * Node.js-specific wrapper for Python project dependency parsing.
 * Pure string-parsing functions live in parserCore.js (browser-compatible).
 * This module adds file-system operations: reading local files, resolving -r
 * includes in requirements.txt, and discovering which dep file to parse.
 * File-system imports must not be added to parserCore.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isTestRequirementsFile } from './testFilter.js';
import { normalizePackageName } from './pypiClient.js';
import {
  parseDependencyString,
  parseRequiresDist,
  parsePyprojectToml,
  parseSetupCfg,
  parsePipfile,
  parseManifestJson,
  parsePep508UrlRequirement,
} from './parserCore.js';

/**
 * Recognised plain-text requirements filenames, in parse priority order.
 * `requirements_all.txt` is parsed before `requirements.txt` so that, if it
 * pulls `requirements.txt` in via a `-r` include, the shared `visited` set
 * stops the latter from being parsed a second time as a standalone file.
 */
const REQUIREMENTS_FILES = ['requirements_all.txt', 'requirements.txt'];

/**
 * Parses a requirements.txt file into a list of dependencies.
 * Handles inline comments, blank lines, `-r` file includes (recursively),
 * and common flags that should be ignored (`-i`, `--index-url`, `-c`, `-e`, etc.).
 *
 * Security guards on `-r` includes:
 *   - Path traversal: the resolved include path must start with `projectRoot`.
 *     Includes that escape the project directory (e.g. `-r ../../../etc/shadow`)
 *     are silently skipped.
 *   - Circular includes: `visited` tracks every absolute path already parsed in
 *     this chain. A file that has already been visited is silently skipped,
 *     preventing infinite recursion from self-referencing or A→B→A cycles.
 *
 * @param {string} content      - file content string
 * @param {string} filePath     - absolute path to this file (used to resolve `-r` includes)
 * @param {string} projectRoot  - absolute path to the project root; includes that resolve
 *                                outside this directory are skipped
 * @param {Set<string>} visited - absolute paths already parsed in this include chain
 * @param {boolean} includeTests - when false (default), -r includes whose filename contains
 *                                 a test-related keyword are silently skipped
 * @returns {{ deps: Array<{ name: string, versionSpec: string|null }>, dangerousDeps: Array<{ name: string, spec: string, reason: string }> }}
 */
function parseRequirementsTxt(content, filePath, projectRoot, visited = new Set(), includeTests = false) {
  visited.add(filePath);
  const deps = [];
  const dangerousDeps = [];
  const dir = path.dirname(filePath);

  for (let line of content.split('\n')) {
    // Strip inline comments
    line = line.split('#')[0].trim();
    // Handle line continuation
    while (line.endsWith('\\')) line = line.slice(0, -1).trim();
    if (!line) continue;

    // Recurse into included files: -r other.txt or --requirement other.txt
    if (/^(-r|--requirement)\s+/.test(line)) {
      const includePath = line.replace(/^(-r|--requirement)\s+/, '').trim();

      // Skip test requirement includes unless the caller opted in
      if (!includeTests && isTestRequirementsFile(path.basename(includePath))) continue;

      const fullPath = path.resolve(dir, includePath);

      // Security: skip includes that escape the project root (path traversal guard)
      if (projectRoot && !fullPath.startsWith(projectRoot + path.sep) && fullPath !== projectRoot) continue;

      // Security: skip already-visited files (circular include guard)
      if (visited.has(fullPath)) continue;

      try {
        const includeContent = fs.readFileSync(fullPath, 'utf8');
        const sub = parseRequirementsTxt(includeContent, fullPath, projectRoot, visited, includeTests);
        deps.push(...sub.deps);
        dangerousDeps.push(...sub.dangerousDeps);
      } catch { /* missing include — skip silently */ }
      continue;
    }

    // Skip all other option flags and editable installs
    if (/^-/.test(line)) continue;

    const dep = parseDependencyString(line);
    if (dep) {
      deps.push(dep);
    } else {
      const danger = parsePep508UrlRequirement(line);
      if (danger) dangerousDeps.push(danger);
    }
  }

  return { deps, dangerousDeps };
}

/**
 * Merges dependency lists drawn from multiple requirements files into a single
 * deduplicated array. Packages are keyed by their PEP 503-normalised name.
 * When the same package appears in more than one file, its version constraints
 * are combined with a comma so resolveVersion treats them as a joint constraint.
 * The first occurrence's original name casing is preserved.
 * Does not mutate the input array.
 * @param {Array<{ name: string, versionSpec: string|null }>} allDeps
 * @returns {Array<{ name: string, versionSpec: string|null }>}
 */
function mergeRequirementsDeps(allDeps) {
  /** @type {Map<string, { name: string, versionSpec: string|null }>} */
  const map = new Map();

  for (const dep of allDeps) {
    const key = normalizePackageName(dep.name);
    if (!map.has(key)) {
      map.set(key, { name: dep.name, versionSpec: dep.versionSpec });
    } else {
      const existing = map.get(key);
      if (dep.versionSpec && existing.versionSpec) {
        existing.versionSpec = `${existing.versionSpec},${dep.versionSpec}`;
      } else if (dep.versionSpec) {
        existing.versionSpec = dep.versionSpec;
      }
    }
  }

  return [...map.values()];
}

/**
 * Parses every plain-text requirements file present in a project directory
 * (`requirements_all.txt` and `requirements.txt`) and merges the results.
 *
 * The two parses share one `visited` set: if `requirements_all.txt` pulls in
 * `requirements.txt` via a `-r` include, the standalone parse of
 * `requirements.txt` is skipped so its packages are not counted twice. Any
 * remaining overlap (the same package listed independently in both files) is
 * collapsed by mergeRequirementsDeps.
 *
 * @param {string} projectPath - absolute path to the Python project root
 * @param {boolean} includeTests - forwarded to parseRequirementsTxt
 * @returns {{ deps: Array<{ name: string, versionSpec: string|null }>, dangerousDeps: Array<{ name: string, spec: string, reason: string }>, source: string }|null}
 *   null when no requirements file is present in the directory
 */
function parseRequirementsFiles(projectPath, includeTests) {
  const visited = new Set();
  const allDeps = [];
  const allDangerousDeps = [];
  const sources = [];

  for (const file of REQUIREMENTS_FILES) {
    const fullPath = path.join(projectPath, file);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
    // Already pulled in via a `-r` include from an earlier requirements file —
    // don't parse it again as a standalone source.
    if (visited.has(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const { deps, dangerousDeps } = parseRequirementsTxt(content, fullPath, projectPath, visited, includeTests);
      allDeps.push(...deps);
      allDangerousDeps.push(...dangerousDeps);
      sources.push(file);
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
  }

  if (sources.length === 0) return null;
  return { deps: mergeRequirementsDeps(allDeps), dangerousDeps: allDangerousDeps, source: sources.join(', ') };
}

/**
 * Detects and parses the Python dependency file(s) in a given project directory.
 * Priority order: pyproject.toml → manifest.json → requirements*.txt → setup.cfg → Pipfile.
 * When both `requirements.txt` and `requirements_all.txt` are present, both are
 * parsed and merged into a single dependency list.
 * Returns the parsed dependencies and a label indicating which file(s) were used.
 * @param {string} projectPath - absolute path to the Python project root
 * @param {{ includeTests?: boolean }} [options] - parsing options
 * @param {boolean} [options.includeTests=false] - when true, test/dev dependencies are
 *   included alongside regular production dependencies
 * @returns {{ deps: Array<{ name: string, versionSpec: string|null }>, source: string }}
 */
function parseDependencyFile(projectPath, options = {}) {
  const { includeTests = false } = options;

  /**
   * Reads and parses a single dependency file if it exists.
   * Parsers that do not detect non-standard deps return dangerousDeps: [].
   * @param {string} file - filename relative to projectPath
   * @param {(content: string, fullPath: string) => Array} parse
   * @returns {{ deps: Array, dangerousDeps: Array, source: string }|null} null when the file is absent
   */
  const tryFile = (file, parse) => {
    const fullPath = path.join(projectPath, file);
    // Guard against a directory entry matching the filename (e.g. case-insensitive fs)
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return null;
    try {
      return { deps: parse(fs.readFileSync(fullPath, 'utf8'), fullPath), dangerousDeps: [], source: file };
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
  };

  const result =
    tryFile('pyproject.toml', (c) => parsePyprojectToml(c, includeTests)) ??
    tryFile('manifest.json',  (c) => parseManifestJson(c)) ??
    parseRequirementsFiles(projectPath, includeTests) ??
    tryFile('setup.cfg', (c) => parseSetupCfg(c)) ??
    tryFile('Pipfile',   (c) => parsePipfile(c, includeTests));

  if (result) return result;

  throw new Error(
    `No dependency file found in ${projectPath}. ` +
    `Looked for: pyproject.toml, manifest.json, requirements.txt, requirements_all.txt, setup.cfg, Pipfile`
  );
}

export { parseDependencyFile, parseRequirementsFiles, mergeRequirementsDeps, parseRequiresDist, parseDependencyString, parsePyprojectToml, parseManifestJson, parseSetupCfg, parsePipfile };
