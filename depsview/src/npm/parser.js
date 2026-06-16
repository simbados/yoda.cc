/**
 * Node.js-specific npm dependency file reader.
 * Checks for lock files first (preferred — contain the full resolved dependency
 * graph at exact versions); falls back to package.json.
 * File-system imports must not be added to parserCore.js or lock parser modules.
 *
 * Lock file priority and parser mapping is driven by NPM_LOCK_FILES from
 * lockRegistry.js — adding a new lock file format only requires a new entry there.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { parsePackageJson             } from './parserCore.js';
import { NPM_LOCK_FILES, NPM_LOCK_FILENAMES } from './lockRegistry.js';
import { normalizePackageName         } from './depResolver.js';
import { partitionNpmPackages         } from './registryFilter.js';

/**
 * Reads and parses npm dependency files from a project directory.
 * Priority is defined by the ordered NPM_LOCK_FILES registry, followed by
 * package.json as a fallback.
 * Returns the parsed deps, a source label, and an optional note string.
 * @param {string} projectPath - absolute path to the npm project root
 * @param {{ includeTests?: boolean }} [options]
 * @returns {{
 *   deps: Array<{ name: string, version?: string, versionSpec?: string|null }>,
 *   source: string,
 *   note: string|null,
 *   privateCount: number,
 *   privatePkgs: Array<{ name: string, url: string }>,
 *   dangerousDeps: Array<{ name: string, spec: string, reason: string }>
 * }}
 */
function parseDependencyFile(projectPath, options = {}) {
  const { includeTests = false } = options;

  for (const { filename, parse, getNote, getWarning, getDangerousDeps } of NPM_LOCK_FILES) {
    const lockPath = path.join(projectPath, filename);
    if (fs.existsSync(lockPath) && !fs.statSync(lockPath).isDirectory()) {
      try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const { publicPkgs, privateCount, privatePkgs } = partitionNpmPackages(parse(content, includeTests));
        const dangerousDeps = getDangerousDeps ? getDangerousDeps(content, includeTests) : [];
        return { deps: publicPkgs, source: filename, note: getNote(content), warning: getWarning(content), privateCount, privatePkgs, dangerousDeps };
      } catch (err) {
        throw new Error(`Failed to parse ${filename}: ${err.message}`);
      }
    }
  }

  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath) && !fs.statSync(pkgPath).isDirectory()) {
    try {
      const { deps, dangerousDeps } = parsePackageJson(fs.readFileSync(pkgPath, 'utf8'), includeTests);
      return { deps, source: 'package.json', note: null, warning: null, privateCount: 0, privatePkgs: [], dangerousDeps };
    } catch (err) {
      throw new Error(`Failed to parse package.json: ${err.message}`);
    }
  }

  throw new Error(`No npm dependency file found in ${projectPath}. Looked for: ${[...NPM_LOCK_FILENAMES].join(', ')}, package.json`);
}

/**
 * Reads package.json at a project root and returns the set of direct dep names
 * (PEP 503-style normalised: lowercased, [-_.]+ collapsed to '-' indirectly via
 * the npm normaliser). Used to populate the direct/transitive footer when
 * resolution was driven by a lock file. Returns an empty Set when package.json
 * is absent, unreadable, or unparseable — the footer simply omits the breakdown.
 * @param {string} dirPath
 * @param {boolean} includeTests
 * @returns {Set<string>}
 */
function readDirectNamesFromPackageJson(dirPath, includeTests) {
  try {
    const content = fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8');
    const { deps } = parsePackageJson(content, includeTests);
    return new Set(deps.map(d => normalizePackageName(d.name)));
  } catch {
    return new Set();
  }
}

export { parseDependencyFile, readDirectNamesFromPackageJson };
