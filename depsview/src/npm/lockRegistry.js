/**
 * Central registry of npm lock file descriptors.
 *
 * This is the single source of truth for which lock files are supported,
 * in what priority order, which parser to call, and what informational note
 * (if any) to surface to the user after parsing.
 *
 * Both the CLI path (src/npm/parser.js) and the web/GitHub path
 * (src/github/parser.js) import from here so that adding a new lock file
 * format only requires:
 *   1. Creating the parser module (e.g. src/npm/myLockParser.js)
 *   2. Adding one entry to NPM_LOCK_FILES below
 *
 * This module is intentionally free of Node.js imports so it can run in the
 * browser (Cloudflare Worker / web UI).
 */

import { parsePackageLock                      } from './lockParser.js';
import { parsePnpmLock, getPnpmMajorVersion    } from './pnpmLockParser.js';
import { parseBunLock                          } from './bunLockParser.js';

/**
 * Ordered list of npm lock file descriptors. Priority = array order; first
 * file found in a project directory wins.
 *
 * Each descriptor has:
 *   filename  {string}   - the file name to look for (e.g. 'package-lock.json')
 *   parse     {Function} - parse(content: string, includeTests: boolean) →
 *                          Array<{ name, version, resolved }>
 *   getNote   {Function} - getNote(content: string) → string|null
 *                          Returns an informational message for the UI, or null.
 */
export const NPM_LOCK_FILES = [
  {
    filename: 'package-lock.json',
    parse:    parsePackageLock,
    getNote:  () => null,
  },
  {
    filename: 'pnpm-lock.yaml',
    parse:    parsePnpmLock,
    getNote:  (content) => getPnpmMajorVersion(content) >= 9
      ? 'pnpm-lock.yaml v9 does not flag packages as dev-only — all installed packages are listed, including test and dev dependencies.'
      : null,
  },
  {
    filename: 'bun.lock',
    parse:    parseBunLock,
    getNote:  () => null,
  },
];

/**
 * Set of all recognised npm lock file names, derived from NPM_LOCK_FILES.
 * Use this for ecosystem detection and isLockFile checks instead of
 * hardcoding individual filenames.
 */
export const NPM_LOCK_FILENAMES = new Set(NPM_LOCK_FILES.map(e => e.filename));
