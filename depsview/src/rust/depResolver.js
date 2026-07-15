/**
 * crates.io dependency resolver.
 *
 * Operates in one of two modes determined by the shape of the input deps:
 *
 *   • LOCKFILE MODE (from Cargo.lock):
 *     Each input dep carries an exact `version`. The lockfile already
 *     enumerates the full transitive closure, so we only fetch crate metadata
 *     (release date, total release count, first-release date) for each one —
 *     no recursive crawl.
 *
 *   • MANIFEST MODE (from Cargo.toml fallback):
 *     Each input dep carries a Cargo `versionSpec`. We fetch the crate's
 *     version list, resolve the best matching version with the Cargo SemVer
 *     rules, then recurse into that version's `/dependencies` endpoint to
 *     discover transitive crates. `normal` + `build` dependency kinds are
 *     followed; `dev` is skipped because a transitive crate's dev-deps are
 *     not part of the consumer's build graph.
 *
 * Concurrency is bounded by a semaphore so a project with many transitive
 * crates does not flood crates.io. A `pending` Map prevents duplicate
 * resolution of the same crate (cycle guard).
 */

import { Semaphore } from '../util/semaphore.js';
import { resolveVersion } from './versionResolver.js';
import { normalizeCrateName } from './parserCore.js';
import {
  fetchCrateInfo,
  fetchCrateVersionDeps,
  getReleaseDate,
  getFirstReleaseDate,
  getReleaseCount,
  getRecentDownloads,
  getVersionList,
} from './cratesClient.js';

const CONCURRENCY = 8;

/**
 * Resolves crate metadata and (in manifest mode) transitive dependencies.
 *
 * Input shape:
 *   - Lockfile mode:  `{ name: string, version: string }`
 *   - Manifest mode:  `{ name: string, versionSpec: string|null }`
 *
 * Returns a Map keyed by `${normalizedName}@${version}` (lockfile) or
 * `${normalizedName}` (manifest) — the same convention as the Go resolver.
 *
 * Result entries mirror the shape used by every other ecosystem so the shared
 * formatter and report generator can render them uniformly.
 *
 * @param {Array<{ name: string, version?: string, versionSpec?: string|null }>} directDeps
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<Map<string, {
 *   name: string, version: string,
 *   releaseDate: string, firstReleaseDate: string,
 *   releaseCount: number, downloadsLastMonth: number|null,
 *   link: string, error?: string
 * }>>}
 */
export async function resolveDependencies(directDeps, opts = {}) {
  const { onProgress } = opts;
  const results   = new Map();
  const pending   = new Map();
  const semaphore = new Semaphore(CONCURRENCY);

  /**
   * Resolves one crate identified by `name` and either an exact `version`
   * (lockfile mode) or a `versionSpec` (manifest mode). The mode is inferred
   * from which field is supplied — when both are present, exact version wins.
   * @param {string} name
   * @param {string|undefined} version
   * @param {string|null|undefined} versionSpec
   * @returns {Promise<void>}
   */
  function resolveOne(name, version, versionSpec) {
    const exact = typeof version === 'string' && version.length > 0;
    const norm = normalizeCrateName(name);
    const pendingKey = exact ? `${norm}@${version}` : norm;
    if (pending.has(pendingKey)) return pending.get(pendingKey);

    const promise = (async () => {
      try {
        await semaphore.acquire();
        let crateData;
        try {
          crateData = await fetchCrateInfo(name);
        } finally {
          semaphore.release();
        }

        if (!crateData) {
          onProgress?.(`  [warn] Crate not found on crates.io: ${name}`);
          results.set(pendingKey, {
            name,
            version:            version ?? (versionSpec ?? 'unknown'),
            releaseDate:        'unknown',
            firstReleaseDate:   'unknown',
            releaseCount:       0,
            downloadsLastMonth: null,
            link:               `https://crates.io/crates/${name}`,
            error:              'Crate not found on crates.io',
          });
          return;
        }

        // recent_downloads is a crate-level (last-90-days) figure that comes
        // with the crate record, so it is available on every successful fetch
        // regardless of which version we ultimately resolve.
        const recentDownloads = getRecentDownloads(crateData.crate);

        // Determine the version to surface and (in manifest mode) recurse into.
        let resolvedVersion = version;
        if (!exact) {
          const allVersions = getVersionList(crateData.versions);
          const { version: chosen } = resolveVersion(versionSpec ?? null, allVersions);
          if (chosen === null) {
            const specLabel = versionSpec ?? '(unknown spec)';
            onProgress?.(`  [warn] No version matching "${specLabel}" found for ${name}`);
            results.set(pendingKey, {
              name:               crateData.crate.name,
              version:            'not found',
              releaseDate:        'unknown',
              firstReleaseDate:   getFirstReleaseDate(crateData.versions),
              releaseCount:       getReleaseCount(crateData.versions),
              downloadsLastMonth: recentDownloads,
              link:               `https://crates.io/crates/${crateData.crate.name}`,
              error:              `No version matching "${specLabel}" found on crates.io`,
            });
            return;
          }
          resolvedVersion = chosen;
        }

        const resolvedName     = crateData.crate.name;
        const releaseDate      = getReleaseDate(crateData.versions, resolvedVersion);
        const firstReleaseDate = getFirstReleaseDate(crateData.versions);
        const releaseCount     = getReleaseCount(crateData.versions);
        const link             = `https://crates.io/crates/${resolvedName}/${resolvedVersion}`;

        const resultKey = exact ? `${normalizeCrateName(resolvedName)}@${resolvedVersion}` : normalizeCrateName(resolvedName);
        if (!results.has(resultKey)) {
          results.set(resultKey, {
            name:               resolvedName,
            version:            resolvedVersion,
            releaseDate,
            firstReleaseDate,
            releaseCount,
            downloadsLastMonth: recentDownloads,
            link,
          });
          onProgress?.(`  ${resolvedName} ${resolvedVersion}`);
        }

        // Manifest mode: follow transitive normal + build deps.
        if (!exact) {
          await semaphore.acquire();
          let transitive;
          try {
            transitive = await fetchCrateVersionDeps(resolvedName, resolvedVersion);
          } finally {
            semaphore.release();
          }

          const followable = (transitive ?? []).filter(d =>
            (d.kind === 'normal' || d.kind === 'build') && !d.optional
          );
          await Promise.all(followable.map(d =>
            resolveOne(d.crate_id, undefined, d.req || null)
          ));
        }
      } catch (err) {
        const fallbackKey = pendingKey;
        if (!results.has(fallbackKey)) {
          results.set(fallbackKey, {
            name,
            version:            version ?? (versionSpec ?? 'error'),
            releaseDate:        'unknown',
            firstReleaseDate:   'unknown',
            releaseCount:       0,
            downloadsLastMonth: null,
            link:               `https://crates.io/crates/${name}`,
            error:              err.message,
          });
        }
      }
    })();

    pending.set(pendingKey, promise);
    return promise;
  }

  await Promise.all(directDeps.map(dep =>
    resolveOne(dep.name, dep.version, dep.versionSpec)
  ));
  return results;
}
