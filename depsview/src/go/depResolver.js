/**
 * Go module dependency resolver.
 *
 * Recursively resolves the full dependency tree of a Go module by fetching each
 * module's go.mod from the proxy and following its `require` directives. Go
 * always pins exact versions in go.mod, so no semver resolution is needed.
 *
 * When a path returns 404, the resolver walks up the path segments to find the
 * containing module root (e.g. "golang.org/x/lint/golint" → "golang.org/x/lint").
 * This mirrors what `go install` does and lets users enter tool package paths
 * directly.
 *
 * For each module we issue up to three requests:
 *   1. `/{module}/@v/{version}.info` → release date of the pinned version
 *   2. `/{module}/@v/list`           → total number of tagged releases
 *   3. `/{module}/@v/{version}.mod`  → go.mod for transitive dep discovery
 *
 * Concurrency is bounded by a semaphore so a project with many transitive deps
 * does not flood the proxy. A pending Map prevents duplicate resolution of the
 * same module@version (cycle guard).
 */

import { fetchModuleInfo, fetchModuleVersionList, fetchModuleMod, getReleaseDate } from './goClient.js';
import { parseGoMod } from './parserCore.js';
import { Semaphore } from '../util/semaphore.js';

const CONCURRENCY = 10;

/**
 * Recursively resolves release metadata for a list of Go module dependencies,
 * following transitive requires in each module's go.mod.
 *
 * Each result entry mirrors the shape used by the npm/Python resolvers so the
 * shared formatter and report generator can render it uniformly. The Go proxy
 * does not expose download statistics, so `downloadsLastMonth` is null.
 *
 * @param {Array<{ name: string, version: string }>} directDeps - parsed module list
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<Map<string, { name: string, version: string, releaseDate: string, firstReleaseDate: string, releaseCount: number, downloadsLastMonth: number|null, link: string, error?: string }>>}
 */
export async function resolveDependencies(directDeps, opts = {}) {
  const { onProgress } = opts;
  const results   = new Map();
  const pending   = new Map();
  const semaphore = new Semaphore(CONCURRENCY);

  /**
   * Tries the given path first; on 404 walks up path segments to find the
   * containing module root. Returns { moduleName, info } or null if not found
   * at any level. Minimum candidate length is 2 segments (e.g. "gopkg.in/pkg").
   */
  async function resolveModuleInfo(name, version) {
    const info = await fetchModuleInfo(name, version);
    if (info) return { moduleName: name, info };
    const segments = name.split('/');
    for (let i = segments.length - 1; i >= 2; i--) {
      const candidate = segments.slice(0, i).join('/');
      const parentInfo = await fetchModuleInfo(candidate, version);
      if (parentInfo) return { moduleName: candidate, info: parentInfo };
    }
    return null;
  }

  function resolveOne(name, version) {
    const pendingKey = `${name.toLowerCase()}@${version}`;
    if (pending.has(pendingKey)) return Promise.resolve();

    const promise = (async () => {
      try {
        await semaphore.acquire();
        let moduleName = name;
        let info, versions, modText;
        try {
          const moduleResolution = await resolveModuleInfo(name, version);
          if (moduleResolution) {
            moduleName = moduleResolution.moduleName;
            info       = moduleResolution.info;
            const resolvedVersionForMod = (version === 'latest' && info.Version) ? info.Version : version;
            [versions, modText] = await Promise.all([
              fetchModuleVersionList(moduleName),
              fetchModuleMod(moduleName, resolvedVersionForMod),
            ]);
          } else {
            versions = [];
            modText  = null;
          }
        } finally {
          semaphore.release();
        }

        const resolvedVersion = (version === 'latest' && info?.Version) ? info.Version : version;
        const key  = `${moduleName.toLowerCase()}@${resolvedVersion}`;
        const link = `https://pkg.go.dev/${moduleName}@${resolvedVersion}`;

        if (!info) {
          onProgress?.(`  [warn] Module not found on proxy.golang.org: ${name}@${version}`);
          results.set(`${name.toLowerCase()}@${version}`, {
            name,
            version,
            releaseDate:        'unknown',
            firstReleaseDate:   'unknown',
            releaseCount:       0,
            downloadsLastMonth: null,
            link:               `https://pkg.go.dev/${name}@${version}`,
            error:              'Module not found on proxy.golang.org',
          });
          return;
        }

        if (results.has(key)) return;

        const releaseDate = getReleaseDate(info);
        onProgress?.(`  ${moduleName} ${resolvedVersion}`);

        results.set(key, {
          name:               moduleName,
          version:            resolvedVersion,
          releaseDate,
          firstReleaseDate:   'unknown',
          releaseCount:       versions.length,
          downloadsLastMonth: null,
          link,
        });

        if (modText) {
          const transitive = parseGoMod(modText);
          await Promise.all(transitive.map(({ name: depName, version: depVersion }) =>
            resolveOne(depName, depVersion)
          ));
        }
      } catch (err) {
        const fallbackKey = `${name.toLowerCase()}@${version}`;
        if (!results.has(fallbackKey)) {
          results.set(fallbackKey, {
            name,
            version,
            releaseDate:        'unknown',
            firstReleaseDate:   'unknown',
            releaseCount:       0,
            downloadsLastMonth: null,
            link: `https://pkg.go.dev/${name}@${version}`,
            error:              err.message,
          });
        }
      }
    })();

    pending.set(pendingKey, promise);
    return promise;
  }

  await Promise.all(directDeps.map(({ name, version }) => resolveOne(name, version)));
  return results;
}
