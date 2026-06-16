/**
 * Central registry of npm lock file descriptors.
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
import { parseBunLock, parseBunDangerousDeps   } from './bunLockParser.js';
import { parseYarnLock, getYarnMajorVersion    } from './yarnLockParser.js';

/**
 * Ordered list of npm lock file descriptors. Priority = array order; first
 * file found in a project directory wins.
 *
 * Each descriptor has:
 *   filename    {string}   - file name (e.g. 'package-lock.json')
 *   parse       {Function} - parse(content, includeTests) → Array<{name, version, resolved}>
 *   getNote     {Function} - getNote(content) → string|null
 *                            Informational message shown after results (ⓘ icon).
 *   getWarning  {Function} - getWarning(content) → string|null
 *                            Privacy/security concern that requires user confirmation
 *                            before resolution proceeds. Displayed as ⚠ on CLI (stderr)
 *                            and as a modal dialog in the web UI.
 *   getDangerousDeps {Function} - getDangerousDeps(content, includeTests) →
 *                                  Array<{ name, spec, reason }>
 *                                  Non-registry dependency entries surfaced in the
 *                                  "non-standard sources" block (file:/link:/git:/
 *                                  github:/tarball entries from a lock file).
 *                                  Defaults to () => [] for formats whose lockfile
 *                                  cannot encode non-registry deps inline.
 */
export const NPM_LOCK_FILES = [
  {
    filename:         'package-lock.json',
    parse:            parsePackageLock,
    getNote:          () => null,
    getWarning:       () => null,
    getDangerousDeps: () => [],
  },
  {
    filename:         'pnpm-lock.yaml',
    parse:            parsePnpmLock,
    getNote:    (content) => getPnpmMajorVersion(content) >= 9
      ? 'pnpm-lock.yaml v9 does not flag packages as dev-only — all installed packages are listed, including test and dev dependencies.'
      : null,
    getWarning:       () => null,
    getDangerousDeps: () => [],
  },
  {
    filename:         'bun.lock',
    parse:            parseBunLock,
    getNote:          () => null,
    getWarning:       () => null,
    getDangerousDeps: parseBunDangerousDeps,
  },
  {
    filename:         'yarn.lock',
    parse:            parseYarnLock,
    getNote:    () => 'yarn.lock does not flag packages as dev-only — all installed packages are listed, including test and dev dependencies.',
    getWarning: (content) => getYarnMajorVersion(content) === 2
      ? 'Yarn Berry (v2+) does not store registry URLs in yarn.lock — private registry packages cannot be detected and will be looked up against the public npm registry. This may expose internal package names to npm\'s servers. Private registry support requires parsing .yarnrc.yml, which is not yet supported.'
      : null,
    getDangerousDeps: () => [],
  },
];

/**
 * Set of all recognised npm lock file names, derived from NPM_LOCK_FILES.
 * Use this for ecosystem detection and isLockFile checks instead of
 * hardcoding individual filenames.
 */
export const NPM_LOCK_FILENAMES = new Set(NPM_LOCK_FILES.map(e => e.filename));
