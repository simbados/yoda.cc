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
 */

import fs   from 'node:fs';
import path from 'node:path';

import { orchestrate, packagesForSocket } from './orchestrator.js';
import { formatMulti, formatJson, ECOSYSTEM_ORDER } from './output/formatter.js';
import { generateReport                  } from './output/reportGenerator.js';
import { fetchSocketScores               } from './socket/client.js';
import { setDebug                        } from './util/debugging.js';
import { isGithubUrl, parseGithubUrl     } from './github/url.js';
import { listDirectory                   } from './github/client.js';

/** npm-specific filenames checked during ecosystem detection. */
const NPM_FILES    = new Set(['package-lock.json', 'pnpm-lock.yaml', 'package.json']);
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
 * Socket.dev credentials can also be supplied via `SOCKET_KEY` / `SOCKET_ORG`
 * env vars; the `--socket-key` / `--socket-org` flags take precedence.
 *
 * @returns {{
 *   projectPath: string,
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

  const positional = args.filter(a => !a.startsWith('--'));

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

  if (positional.length === 0) {
    console.error('Usage: depsview <path-to-project|github-url> [--npm] [--python] [--go] [--json] [--debug] [--include-tests]');
    console.error('       [--download-stats|--ds] [--socket-key=<key>] [--socket-org=<slug>] [--report[=<file>]]');
    console.error('');
    console.error('Ecosystem flags act as filters; with none, every detected ecosystem is included.');
    console.error('Python files: pyproject.toml, manifest.json, requirements.txt, requirements_all.txt, setup.cfg, Pipfile');
    console.error('npm files:    package-lock.json, pnpm-lock.yaml (preferred), package.json');
    console.error('Go files:     go.sum (preferred), go.mod');
    process.exit(1);
  }

  return {
    projectPath: positional[0],
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
async function main() {
  const {
    projectPath, json, debug, includeTests, downloadStats,
    requestedEcosystems, socketKey, socketOrg, reportPath,
  } = parseArgs();
  if (debug) setDebug(true);

  const isGithub = isGithubUrl(projectPath);
  const githubRef = isGithub ? parseGithubUrl(projectPath) : null;
  const absolutePath = isGithub ? null : path.resolve(projectPath);

  // ── Detection ─────────────────────────────────────────────────────────────
  let detected;
  if (isGithub) {
    const listing = await listDirectory(githubRef.owner, githubRef.repo, githubRef.subpath, githubRef.ref);
    detected = detectGithubEcosystems(listing ?? []);
  } else {
    detected = detectLocalEcosystems(absolutePath);
  }

  const ecosystems = resolveEcosystems(requestedEcosystems, detected);

  if (!json) {
    const list = [...ecosystems].join(', ') || '(none)';
    console.log(`Resolving ecosystems: ${list}…\n`);
  }

  // ── Orchestrate parse + resolve in parallel ───────────────────────────────
  const sections = await orchestrate(
    { isGithub, githubRef, absolutePath },
    {
      ecosystems,
      includeTests,
      downloadStats,
      onProgress: json ? undefined : msg => process.stderr.write(msg + '\n'),
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
    // Every section either errored or returned no packages. Exit cleanly with no output.
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
