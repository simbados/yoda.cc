/**
 * Homebrew transitive dependency resolver.
 * Walks the full dependency tree of a formula using BFS, fetching each
 * formula's metadata from the Homebrew API and recording its runtime
 * (and optionally build) dependencies.
 *
 * System libraries listed under uses_from_macos are excluded — they are
 * OS-provided and not Homebrew packages.
 */

import { fetchFormula, fetchFormulaLastUpdated, RateLimitError } from './client.js';

/**
 * Sums all install counts from an analytics period object.
 * The analytics data is a map of "name version" → count; summing all values
 * gives the total installs for that formula across all versions.
 * Returns null when the analytics data is absent or empty.
 * @param {object|null|undefined} analytics - formula analytics block
 * @param {'30d'|'90d'|'365d'} [period='365d']
 * @returns {number|null}
 */
export function totalInstalls(analytics, period = '365d') {
  const data = analytics?.install?.[period];
  if (!data || Object.keys(data).length === 0) return null;
  return Object.values(data).reduce((sum, n) => sum + n, 0);
}

/**
 * Normalises a raw formula JSON object into a resolved package record.
 * Runtime and recommended dependencies are always included.
 * Build dependencies are included only when opts.includeBuildDeps is true.
 * System dependencies (uses_from_macos) are excluded.
 * @param {object} data - raw formula JSON from the Homebrew API
 * @param {{ includeBuildDeps?: boolean }} [opts]
 * @returns {{ name: string, version: string, deps: string[], installs365: number|null, installs30: number|null, link: string, type: 'formula', rubySourcePath: string|null }}
 */
export function parseFormula(data, opts = {}) {
  const { includeBuildDeps = false } = opts;
  const deps = [
    ...(data.dependencies             ?? []),
    ...(data.recommended_dependencies ?? []),
    ...(includeBuildDeps ? (data.build_dependencies ?? []) : []),
  ];
  return {
    name:           data.name,
    version:        data.versions?.stable ?? 'unknown',
    deps:           [...new Set(deps)],
    installs365:    totalInstalls(data.analytics, '365d'),
    installs30:     totalInstalls(data.analytics, '30d'),
    link:           `https://formulae.brew.sh/formula/${data.name}`,
    type:           'formula',
    rubySourcePath: data.ruby_source_path ?? null,
  };
}

/**
 * Resolves the full transitive dependency tree for a Homebrew formula using BFS.
 * The root formula is included in the result map at depth 0.
 * Each resolved package carries a `depth` field: 0 = root, 1 = direct dep,
 * 2+ = transitive dep. Packages that fail to fetch are recorded with error = message.
 * Does not mutate any input; returns a new Map on each call.
 *
 * `rateLimited` is true when at least one update-date request hit the GitHub
 * API rate limit — in that case some packages' `updatedAt` will be null even
 * though the formula itself resolved fine, and the caller should surface it.
 *
 * @param {string} rootName - formula name to start from
 * @param {{ includeBuildDeps?: boolean, onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<{ results: Map<string, object>, rateLimited: boolean }>}
 *   results: name → package record (includes updatedAt); rateLimited: see above
 */
export async function resolve(rootName, opts = {}) {
  const { includeBuildDeps = false, onProgress } = opts;

  // ── Phase 1: BFS — resolve formula metadata ───────────────────────────────
  // parseFormula() returns rubySourcePath, which is spread into pkg below.
  // The catch branch sets rubySourcePath: null since no data was retrieved.
  const results = new Map();
  const queue   = [{ name: rootName, depth: 0 }];
  const visited = new Set();

  while (queue.length > 0) {
    const { name, depth } = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);

    onProgress?.(`Resolving ${name}…`);

    let pkg;
    try {
      const data = await fetchFormula(name);
      pkg = { ...parseFormula(data, { includeBuildDeps }), depth };
    } catch (err) {
      pkg = {
        name,
        version:        'unknown',
        deps:           [],
        installs365:    null,
        installs30:     null,
        link:           `https://formulae.brew.sh/formula/${name}`,
        type:           'formula',
        rubySourcePath: null,
        depth,
        error:          err.message,
      };
    }

    results.set(name, pkg);

    for (const dep of pkg.deps) {
      if (!visited.has(dep)) queue.push({ name: dep, depth: depth + 1 });
    }
  }

  // ── Phase 2: fetch last-updated dates in parallel ─────────────────────────
  // Queries the GitHub commits API for each formula's Ruby source file in
  // homebrew-core. All requests fire concurrently to minimise total latency.
  // A rate-limit response (403/429) on any one request is caught and recorded;
  // the affected package's updatedAt stays null and resolution still completes.
  onProgress?.('Fetching update dates from GitHub…');
  let rateLimited = false;
  await Promise.all(
    [...results.values()]
      .filter(pkg => !pkg.error && pkg.rubySourcePath)
      .map(async pkg => {
        try {
          pkg.updatedAt = await fetchFormulaLastUpdated(pkg.rubySourcePath);
        } catch (err) {
          pkg.updatedAt = null;
          if (err instanceof RateLimitError) rateLimited = true;
        }
      })
  );
  if (rateLimited) {
    onProgress?.('⚠ GitHub API rate limit reached — some update dates are unavailable.');
  }

  return { results, rateLimited };
}
