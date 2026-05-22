/**
 * Multi-ecosystem orchestrator.
 *
 * Given a project (local path or parsed GitHub reference) and a set of
 * requested ecosystems, runs the parse + resolve pipeline for each ecosystem
 * in parallel and returns one "section" object per ecosystem.
 *
 * Each section is fully self-describing — its source filename, parsed deps,
 * resolved results map, direct-name set, and any informational note all live
 * together so the formatter and report generator can render the section in
 * isolation without having to consult global state.
 *
 * Errors are isolated per ecosystem: a malformed go.mod will surface as an
 * `error` field on the Go section but will not prevent the npm or Python
 * sections from resolving and rendering.
 */

import { parseDependencyFile    as parseNpmFile,
         readDirectNamesFromPackageJson } from './npm/parser.js';
import { resolveDependencies    as resolveNpm,
         normalizePackageName   as normalizeNpm } from './npm/depResolver.js';

import { parseDependencyFile    as parsePythonFile } from './python/parser.js';
import { resolveDependencies    as resolvePython }   from './python/depResolver.js';
import { normalizePackageName   as normalizePython } from './python/pypiClient.js';

import { parseDependencyFile    as parseGoFile,
         readDirectNamesFromGoMod        } from './go/parser.js';
import { resolveDependencies    as resolveGo } from './go/depResolver.js';
import { parseGoMod                       } from './go/parserCore.js';

import { parseGithubNpmDependencies,
         parseGithubGoDependencies,
         parseGithubDependencies         } from './github/parser.js';
import { fetchFileContent                } from './github/client.js';

/**
 * Normaliser used when matching resolved package names back to the directName
 * set. Mirrors the formatter's normalisation (`[-_.]+` → `-`) so Python /
 * Go names compare uniformly across the pipeline.
 * @param {string} name
 * @returns {string}
 */
function formatterNorm(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Pulls go.mod from a GitHub repo subpath and returns the set of non-`// indirect`
 * module names. Used to populate `directNames` when the primary source is go.sum.
 * @param {{ owner: string, repo: string, ref: string, subpath: string }} githubRef
 * @returns {Promise<Set<string>>}
 */
async function readDirectGoNamesFromGithub({ owner, repo, ref, subpath }) {
  const filePath = subpath ? `${subpath}/go.mod` : 'go.mod';
  const content = await fetchFileContent(owner, repo, filePath, ref);
  if (!content) return new Set();
  try {
    return new Set(parseGoMod(content).filter(d => !d.indirect).map(d => d.name.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Parses the appropriate dependency file(s) for one ecosystem.
 * Returns the same shape regardless of source (`{ deps, source, note? }`).
 *
 * When `ctx.isPackage` is true, skips all file/network parsing and returns a
 * single-element dep list built from `ctx.packageDep` ({ name, version }).
 * The dep object is shaped for each resolver: npm/python receive `versionSpec`,
 * go receives `version`.
 *
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {object} ctx              - { isGithub, githubRef, absolutePath } or { isPackage, packageDep }
 * @param {object} opts             - { includeTests }
 * @returns {Promise<{ deps: Array, source: string, note?: string }>}
 */
async function parseSection(ecosystem, ctx, opts) {
  if (ctx.isPackage) {
    const { name, version } = ctx.packageDep;
    const dep = ecosystem === 'go'
      ? { name, version }
      : { name, versionSpec: version };
    return { deps: [dep], source: 'package search', note: null };
  }

  const { isGithub, githubRef, absolutePath } = ctx;
  const { includeTests } = opts;

  if (ecosystem === 'npm') {
    return isGithub
      ? await parseGithubNpmDependencies(githubRef, { includeTests })
      : parseNpmFile(absolutePath, { includeTests });
  }
  if (ecosystem === 'go') {
    return isGithub
      ? await parseGithubGoDependencies(githubRef)
      : parseGoFile(absolutePath);
  }
  // python
  return isGithub
    ? await parseGithubDependencies(githubRef, { includeTests })
    : parsePythonFile(absolutePath, { includeTests });
}

/**
 * Resolves an array of parsed deps to a results Map for one ecosystem.
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {Array} deps
 * @param {{ downloadStats: boolean, onProgress?: function }} opts
 * @returns {Promise<Map<string, object>>}
 */
async function resolveSectionDeps(ecosystem, deps, opts) {
  const { downloadStats, onProgress } = opts;
  if (ecosystem === 'npm')    return resolveNpm(deps,    { onProgress });
  if (ecosystem === 'go')     return resolveGo(deps,     { onProgress });
  return resolvePython(deps, { onProgress, downloadStats });
}

/**
 * Computes the set of direct (non-transitive) dependency names for one
 * ecosystem section. Names are normalised with the formatter's `[-_.]+ → -`
 * rule so the footer counts compare correctly later.
 *
 * In package-search mode (`ctx.isPackage`), only the searched package itself
 * is direct; all transitively resolved packages are considered indirect.
 *
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {Array}  deps
 * @param {string} source            - dep file name returned by the parser
 * @param {object} ctx               - { isGithub, githubRef, absolutePath } or { isPackage, packageDep }
 * @param {{ includeTests: boolean }} opts
 * @returns {Promise<Set<string>>}
 */
async function directNamesForSection(ecosystem, deps, source, ctx, opts) {
  if (ctx.isPackage) {
    if (ecosystem === 'go')     return new Set([formatterNorm(ctx.packageDep.name)]);
    if (ecosystem === 'npm')    return new Set([normalizeNpm(ctx.packageDep.name)]);
    return new Set([normalizePython(ctx.packageDep.name)]);
  }

  const { isGithub, githubRef, absolutePath } = ctx;
  const { includeTests } = opts;

  if (ecosystem === 'npm') {
    const isLockFile = source === 'package-lock.json' || source === 'pnpm-lock.yaml';
    if (!isLockFile) return new Set(deps.map(d => normalizeNpm(d.name)));
    return isGithub ? new Set() : readDirectNamesFromPackageJson(absolutePath, includeTests);
  }

  if (ecosystem === 'go') {
    if (source === 'go.sum') {
      const raw = isGithub
        ? await readDirectGoNamesFromGithub(githubRef)
        : readDirectNamesFromGoMod(absolutePath);
      return new Set([...raw].map(formatterNorm));
    }
    return new Set(deps.filter(d => !d.indirect).map(d => formatterNorm(d.name)));
  }

  return new Set(deps.map(d => normalizePython(d.name)));
}

/**
 * Runs parse → resolve → directNames for one ecosystem, catching any error
 * along the way and returning it on the section so the rest of the pipeline
 * can continue.
 *
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {object} ctx   - { isGithub, githubRef, absolutePath }
 * @param {object} opts  - { includeTests, downloadStats, onProgress }
 * @returns {Promise<object>} section
 */
async function buildSection(ecosystem, ctx, opts) {
  try {
    const { deps, source, note = null, privateCount = 0 } = await parseSection(ecosystem, ctx, opts);
    const results       = await resolveSectionDeps(ecosystem, deps, opts);
    const directNames   = await directNamesForSection(ecosystem, deps, source, ctx, opts);
    return { ecosystem, source, deps, results, directNames, note, privateCount };
  } catch (err) {
    return { ecosystem, error: err.message };
  }
}

/**
 * Orchestrates parsing + resolution across a set of ecosystems in parallel.
 * @param {object} ctx
 * @param {boolean}     ctx.isGithub
 * @param {object|null} ctx.githubRef
 * @param {string|null} ctx.absolutePath
 * @param {object} opts
 * @param {Set<'npm'|'python'|'go'>} opts.ecosystems
 * @param {boolean}                  opts.includeTests
 * @param {boolean}                  opts.downloadStats
 * @param {function}                 [opts.onProgress]
 * @returns {Promise<Map<'npm'|'python'|'go', object>>} sections
 */
async function orchestrate(ctx, opts) {
  const { ecosystems, includeTests, downloadStats, onProgress } = opts;
  const list = [...ecosystems];
  const sections = new Map();

  const settled = await Promise.all(
    list.map(eco => buildSection(eco, ctx, { includeTests, downloadStats, onProgress }))
  );
  for (const section of settled) sections.set(section.ecosystem, section);
  return sections;
}

/**
 * Flattens all resolved packages from every section into the shape expected by
 * the socket.dev client (`{ name, version, ecosystem }` where ecosystem is the
 * PURL type — `npm`, `pypi`, `golang`).
 * Excludes packages flagged with an error so failed lookups are not retried via socket.
 * @param {Map<'npm'|'python'|'go', object>} sections
 * @returns {Array<{ name: string, version: string, ecosystem: 'npm'|'pypi'|'golang' }>}
 */
function packagesForSocket(sections) {
  const all = [];
  for (const [ecosystem, section] of sections) {
    if (section.error || !section.results) continue;
    const purl = ecosystem === 'python' ? 'pypi' : ecosystem === 'go' ? 'golang' : 'npm';
    for (const r of section.results.values()) {
      if (r.error) continue;
      all.push({ name: r.name, version: r.version, ecosystem: purl });
    }
  }
  return all;
}

export { orchestrate, packagesForSocket, buildSection, parseSection, resolveSectionDeps, directNamesForSection };
