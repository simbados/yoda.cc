/**
 * Go module dependency resolver.
 *
 * Unlike Python/npm where versions may be supplied as ranges, Go dependency
 * files always pin exact versions (go.sum entries are hash-locked; go.mod
 * `require` directives use a single semver tag). So this resolver does NOT
 * perform version resolution — it just fetches release metadata in parallel
 * for the already-pinned versions.
 *
 * For each module we issue two requests:
 *   1. `/{module}/@v/{version}.info` → release date of the pinned version
 *   2. `/{module}/@v/list`           → total number of tagged releases
 *
 * Concurrency is bounded by a semaphore so a project with thousands of
 * transitive deps does not flood the proxy.
 */

import { fetchModuleInfo, fetchModuleVersionList, getReleaseDate } from './goClient.js';
import { Semaphore } from '../util/semaphore.js';

const CONCURRENCY = 10;

/**
 * Resolves release metadata for a flat list of Go module dependencies.
 *
 * Each result entry mirrors the shape used by the npm/Python resolvers so the
 * shared formatter and report generator can render it uniformly. The Go proxy
 * does not expose download statistics or a reliable first-release timestamp
 * without an extra round-trip per package, so `firstReleaseDate` is reported
 * as "unknown" and `downloadsLastMonth` is null.
 *
 * @param {Array<{ name: string, version: string }>} directDeps - parsed module list
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<Map<string, { name: string, version: string, releaseDate: string, firstReleaseDate: string, releaseCount: number, downloadsLastMonth: number|null, link: string, error?: string }>>}
 */
export async function resolveDependencies(directDeps, opts = {}) {
  const { onProgress } = opts;
  const results   = new Map();
  const semaphore = new Semaphore(CONCURRENCY);

  await Promise.all(directDeps.map(async ({ name, version }) => {
    const key = `${name.toLowerCase()}@${version}`;
    const link = `https://pkg.go.dev/${name}@${version}`;

    try {
      await semaphore.acquire();
      let info, versions;
      try {
        [info, versions] = await Promise.all([
          fetchModuleInfo(name, version),
          fetchModuleVersionList(name),
        ]);
      } finally {
        semaphore.release();
      }

      if (!info) {
        onProgress?.(`  [warn] Module not found on proxy.golang.org: ${name}@${version}`);
        results.set(key, {
          name,
          version,
          releaseDate:        'unknown',
          firstReleaseDate:   'unknown',
          releaseCount:       0,
          downloadsLastMonth: null,
          link,
          error:              'Module not found on proxy.golang.org',
        });
        return;
      }

      const releaseDate = getReleaseDate(info);
      onProgress?.(`  ${name} ${version}`);

      results.set(key, {
        name,
        version,
        releaseDate,
        firstReleaseDate:   'unknown',
        releaseCount:       versions.length,
        downloadsLastMonth: null,
        link,
      });
    } catch (err) {
      results.set(key, {
        name,
        version,
        releaseDate:        'unknown',
        firstReleaseDate:   'unknown',
        releaseCount:       0,
        downloadsLastMonth: null,
        link,
        error:              err.message,
      });
    }
  }));

  return results;
}
