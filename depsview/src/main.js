#!/usr/bin/env node
/**
 * depsview — CLI entry point.
 *
 * Supports Python, npm, and Go projects. Auto-detects every ecosystem present
 * in the project directory or GitHub URL and renders one section per ecosystem
 * (npm → python → go). Pass `--npm`, `--python`, and/or `--go` to filter.
 *
 * Usage:
 *   node src/main.js <path-or-github-url> [--npm] [--python] [--go]
 *                    [--json] [--debug] [--include-tests] [--download-stats|--ds]
 *                    [--socket-key=<key>] [--socket-org=<slug>] [--report[=<file>]]
 *   node src/main.js --package|-p <name> --npm|--python|--go
 */

import fs       from 'node:fs';
import path     from 'node:path';
import readline from 'node:readline';

import { orchestrate, packagesForSocket } from './orchestrator.js';
import { formatMulti, formatJson, ECOSYSTEM_ORDER } from './output/formatter.js';
import { generateReport                  } from './output/reportGenerator.js';
import { fetchSocketScores               } from './socket/client.js';
import { setDebug                        } from './util/debugging.js';
import { isGithubUrl, parseGithubUrl     } from './github/url.js';
import { NPM_LOCK_FILENAMES              } from './npm/lockRegistry.js';
import { listDirectory                   } from './github/client.js';
import { parsePackageInput               } from './packageInput.js';

/** npm-specific filenames checked during ecosystem detection. */
const NPM_FILES    = new Set([...NPM_LOCK_FILENAMES, 'package.json']);
/** Go-specific filenames checked during ecosystem detection. */
const GO_FILES     = new Set(['go.sum', 'go.mod']);
/** Python-specific filenames checked during ecosystem detection. */
const PYTHON_FILES = new Set(['pyproject.toml', 'requirements.txt', 'requirements_all.txt', 'setup.cfg', 'Pipfile', 'manifest.json']);

/**
 * Parses CLI arguments from process.argv.
 *
 * Ecosystem flags (`--npm`, `--python`, `--go`) act as filters: any combination
 * restricts the run to those ecosystems. With no flags, every ecosystem detected
 * at the project root is included.
 *
 * `--package <name>` / `-p <name>` bypasses file detection entirely and resolves
 * a single package by name. Requires exactly one ecosystem flag.
 *
 * Socket.dev credentials can also be supplied via `SOCKET_KEY` / `SOCKET_ORG`
 * env vars; the `--socket-key` / `--socket-org` flags take precedence.
 *
 * @returns {{
 *   projectPath: string|null,
 *   packageName: string|null,
 *   json: boolean,
 *   debug: boolean,
 *   includeTests: boolean,
 *   downloadStats: boolean,
 *   requestedEcosystems: Set<'npm'|'python'|'go'>,
 *   socketKey: string|null,
 *   socketOrg: string|null,
 *   reportPath: string|null,
 * }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const jsonFlag          = args.includes('--json');
  const debugFlag         = args.includes('--debug');
  const includeTestsFlag  = args.includes('--include-tests');
  const downloadStatsFlag = args.includes('--download-stats') || args.includes('--ds');

  const requestedEcosystems = new Set();
  if (args.includes('--npm'))    requestedEcosystems.add('npm');
  if (args.includes('--python')) requestedEcosystems.add('python');
  if (args.includes('--go'))     requestedEcosystems.add('go');

  // --package <name> or -p <name> or --package=<name> or -p=<name>
  let packageName = null;
  const pkgEqArg = args.find(a => a.startsWith('--package=') || a.startsWith('-p='));
  if (pkgEqArg) {
    packageName = pkgEqArg.startsWith('--package=')
      ? pkgEqArg.slice('--package='.length)
      : pkgEqArg.slice('-p='.length);
  } else {
    const pkgFlagIdx = args.findIndex(a => a === '--package' || a === '-p');
    if (pkgFlagIdx !== -1) packageName = args[pkgFlagIdx + 1] ?? null;
  }

  // Collect positional args, skipping all flags and the value consumed by -p/--package.
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--package') { i++; continue; } // skip flag + value
    if (a.startsWith('-'))               continue;          // skip all other flags
    positional.push(a);
  }

  const socketKeyArg = args.find(a => a.startsWith('--socket-key='));
  const socketOrgArg = args.find(a => a.startsWith('--socket-org='));
  const socketKey    = socketKeyArg ? socketKeyArg.slice('--socket-key='.length) : (process.env.SOCKET_KEY ?? null);
  const socketOrg    = socketOrgArg ? socketOrgArg.slice('--socket-org='.length) : (process.env.SOCKET_ORG ?? null);

  // --report              → write to depsview-report.html
  // --report=custom.html  → write to custom.html
  const reportArg = args.find(a => a === '--report' || a.startsWith('--report='));
  const reportPath = reportArg === undefined
    ? null
    : reportArg === '--report'
      ? 'depsview-report.html'
      : reportArg.slice('--report='.length);

  if (!packageName && positional.length === 0) {
    console.error('Usage: depsview <path-to-project|github-url> [--npm] [--python] [--go] [--json] [--debug] [--include-tests]');
    console.error('       [--download-stats|--ds] [--socket-key=<key>] [--socket-org=<slug>] [--report[=<file>]]');
    console.error('       depsview --package|-p <name> --npm|--python|--go');
    console.error('');
    console.error('Ecosystem flags act as filters; with none, every detected ecosystem is included.');
    console.error('--package / -p: resolve a single package by name (requires exactly one ecosystem flag).');
    console.error('  npm examples:    eslint   eslint@8   @babel/core@7');
    console.error('  python examples: requests   requests>=2.0   requests==2.31.0');
    console.error('  go examples:     github.com/gin-gonic/gin   github.com/gin-gonic/gin@v1.9.1');
    process.exit(1);
  }

  return {
    projectPath: positional[0] ?? null,
    packageName,
    json: jsonFlag,
    debug: debugFlag,
    includeTests: includeTestsFlag,
    downloadStats: downloadStatsFlag,
    requestedEcosystems,
    socketKey,
    socketOrg,
    reportPath,
  };
}

/**
 * Returns the set of ecosystems whose dep files are present in a local directory.
 * @param {string} dirPath
 * @returns {Set<'npm'|'python'|'go'>}
 */
function detectLocalEcosystems(dirPath) {
  const found = new Set();
  for (const f of NPM_FILES)    { if (fs.existsSync(path.join(dirPath, f))) { found.add('npm');    break; } }
  for (const f of GO_FILES)     { if (fs.existsSync(path.join(dirPath, f))) { found.add('go');     break; } }
  for (const f of PYTHON_FILES) { if (fs.existsSync(path.join(dirPath, f))) { found.add('python'); break; } }
  return found;
}

/**
 * Returns the set of ecosystems whose dep files appear in a GitHub directory listing.
 * @param {Array<{ name: string, type: string }>} listing
 * @returns {Set<'npm'|'python'|'go'>}
 */
function detectGithubEcosystems(listing) {
  const names = new Set(listing.map(e => e.name));
  const found = new Set();
  for (const f of NPM_FILES)    { if (names.has(f)) { found.add('npm');    break; } }
  for (const f of GO_FILES)     { if (names.has(f)) { found.add('go');     break; } }
  for (const f of PYTHON_FILES) { if (names.has(f)) { found.add('python'); break; } }
  return found;
}

/**
 * Resolves the set of ecosystems to actually run for this invocation.
 * If the user passed ecosystem flags, those win (intersected with what's
 * sensible). Otherwise, fall back to detection. When detection finds nothing
 * we still try Python so that HA-style nested manifest.json files (which can
 * only be discovered via the depth-2 GitHub traversal) get a chance.
 *
 * @param {Set<'npm'|'python'|'go'>} requested
 * @param {Set<'npm'|'python'|'go'>} detected
 * @returns {Set<'npm'|'python'|'go'>}
 */
function resolveEcosystems(requested, detected) {
  if (requested.size > 0) return requested;
  if (detected.size > 0)  return detected;
  return new Set(['python']);
}

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
/**
 * Prints a ⚠ warning to stderr and asks the user to confirm before proceeding.
 * When stdin is not a TTY (CI, piped output) the warning is still printed but
 * execution is aborted — the user must re-run interactively to proceed.
 * @param {string} warning
 * @returns {Promise<boolean>} true = continue, false = abort
 */
async function confirmWarning(warning) {
  process.stderr.write(`\n⚠  WARNING\n${warning}\n\n`);
  if (!process.stdin.isTTY) {
    process.stderr.write('Non-interactive session detected — aborting. Re-run in a terminal to confirm.\n\n');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question('Continue anyway? [y/N] ', answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const {
    projectPath, packageName, json, debug, includeTests, downloadStats,
    requestedEcosystems, socketKey, socketOrg, reportPath,
  } = parseArgs();
  if (debug) setDebug(true);

  // ── Package-search mode ───────────────────────────────────────────────────
  let ctx;
  let ecosystems;

  if (packageName) {
    if (requestedEcosystems.size !== 1) {
      console.error('Error: --package / -p requires exactly one ecosystem flag (--npm, --python, or --go).');
      process.exit(1);
    }
    const ecosystem  = [...requestedEcosystems][0];
    const packageDep = parsePackageInput(packageName, ecosystem);
    ctx        = { isPackage: true, packageDep };
    ecosystems = requestedEcosystems;

    if (!json) console.log(`Resolving ${ecosystem} package: ${packageDep.name}…\n`);

  // ── Normal path (local dir or GitHub URL) ─────────────────────────────────
  } else {
    const isGithub    = isGithubUrl(projectPath);
    const githubRef   = isGithub ? parseGithubUrl(projectPath) : null;
    const absolutePath = isGithub ? null : path.resolve(projectPath);

    let detected;
    if (isGithub) {
      const listing = await listDirectory(githubRef.owner, githubRef.repo, githubRef.subpath, githubRef.ref);
      detected = detectGithubEcosystems(listing ?? []);
    } else {
      detected = detectLocalEcosystems(absolutePath);
    }

    ecosystems = resolveEcosystems(requestedEcosystems, detected);
    ctx        = { isGithub, githubRef, absolutePath };

    if (!json) {
      const list = [...ecosystems].join(', ') || '(none)';
      console.log(`Resolving ecosystems: ${list}…\n`);
    }
  }

  // ── Orchestrate parse + resolve in parallel ───────────────────────────────
  const sections = await orchestrate(
    ctx,
    {
      ecosystems,
      includeTests,
      downloadStats,
      onProgress: json ? undefined : msg => process.stderr.write(msg + '\n'),
      onWarning:  (warning) => confirmWarning(warning),
    }
  );

  // ── Surface per-ecosystem failures to stderr ──────────────────────────────
  let anyResults = false;
  for (const ecosystem of ECOSYSTEM_ORDER) {
    const section = sections.get(ecosystem);
    if (!section) continue;
    if (section.error) {
      console.error(`[${ecosystem}] failed: ${section.error}`);
    } else if (section.results && section.results.size > 0) {
      anyResults = true;
    }
  }
  if (!anyResults && [...sections.values()].every(s => s.error || !s.results || s.results.size === 0)) {
    if (!json) console.error('No dependencies resolved in any ecosystem.');
    process.exit(0);
  }

  if (!json) process.stderr.write('\n');

  // ── Single socket.dev call across all ecosystems ──────────────────────────
  let socketScores = null;
  if (socketKey && socketOrg) {
    if (!json) process.stderr.write('Fetching supply chain scores from socket.dev…\n');
    const packages = packagesForSocket(sections);
    socketScores = await fetchSocketScores(packages, socketKey, socketOrg);
    if (!json) process.stderr.write('\n');
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const outputOpts = { downloadStats, socketScores };

  if (json) {
    formatJson(sections, outputOpts);
  } else {
    formatMulti(sections, outputOpts);
  }

  if (reportPath) {
    const html = generateReport(sections, outputOpts);
    const resolvedReport = path.resolve(reportPath);
    fs.writeFileSync(resolvedReport, html, 'utf8');
    process.stderr.write(`Report written to ${resolvedReport}\n`);
  }
}

main();
