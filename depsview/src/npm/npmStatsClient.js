/**
 * npm downloads API client (api.npmjs.org).
 *
 * Fetches last-month download counts for npm packages. Unlike the npm registry
 * document (registry.npmjs.org), download counts live on a separate endpoint,
 * so this is an extra network pass on top of resolution.
 *
 * Two request shapes are used:
 *   - Bulk  (unscoped packages): GET /downloads/point/last-month/a,b,c returns a
 *     keyed object `{ a: { downloads }|null, ... }` for up to 128 packages at a
 *     time. This is the cheap path — an entire tree of unscoped packages costs
 *     only ceil(n/128) requests.
 *   - Point (scoped packages @scope/name): the bulk endpoint does not accept
 *     scoped names, so each is fetched individually and returns a flat
 *     `{ downloads, package }` object.
 *
 * api.npmjs.org sends `Access-Control-Allow-Origin: *`, so the browser calls it
 * directly — no CORS proxy is required. This file is therefore browser-safe and
 * must not import any Node.js built-ins.
 *
 * All failures (404, network errors, unexpected shapes) resolve to null so that
 * missing stats never crash or block the main dependency output.
 */

import { fetchWithRetry } from '../util/http.js';
import { Semaphore } from '../util/semaphore.js';

/** Base URL of the npm downloads API. */
const STATS_BASE = 'https://api.npmjs.org/downloads/point/last-month';

/** Max package names the bulk endpoint accepts in a single request. */
const BULK_CHUNK = 128;

/** Concurrency limit for stats requests, matching the registry client. */
const CONCURRENCY = 10;

/** @type {Map<string, number|null>} cache keyed by lowercased package name */
const cache = new Map();

/**
 * Extracts a non-negative integer download count from an api.npmjs.org entry.
 *
 * Both the bulk (`{ downloads }`) and point (`{ downloads, package }`) responses
 * expose the count on a `downloads` field. Returns null when the entry is
 * missing (a package with no download record yet), null (bulk miss), or carries
 * a non-finite / negative value. Mirrors the null-means-unavailable convention
 * used by the Rust and Python download paths so the shared formatter renders a
 * dash.
 *
 * @param {{ downloads?: number }|null|undefined} entry - one download record
 * @returns {number|null}
 */
function getDownloadCount(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.downloads;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Encodes a package name for use as a path segment on the downloads API.
 * `encodeURIComponent` handles both plain names (unchanged) and scoped names
 * (@scope/name → %40scope%2Fname), both of which api.npmjs.org accepts. It also
 * percent-encodes any comma, so encoded names are safe to join for bulk calls
 * without a stray separator being mistaken for a delimiter.
 * @param {string} name
 * @returns {string}
 */
function encodeStatsName(name) {
  return encodeURIComponent(name);
}

/**
 * Splits an array into fixed-size chunks.
 * @template T
 * @param {T[]} arr
 * @param {number} size - chunk length (must be >= 1)
 * @returns {T[][]}
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetches last-month download counts for a set of npm package names.
 *
 * Names are deduplicated case-insensitively and split into unscoped (bulk) and
 * scoped (individual) groups. Results are cached by lowercased name across calls
 * within one run. Any name whose count cannot be determined maps to null.
 *
 * @param {string[]} names - npm package names (scoped or plain)
 * @param {{ baseUrl?: string }} [opts]
 * @param {string} [opts.baseUrl] - override the downloads API base (tests only)
 * @returns {Promise<Map<string, number|null>>} lowercased name → count or null
 */
async function fetchDownloadCounts(names, { baseUrl = STATS_BASE } = {}) {
  if (!baseUrl.startsWith('https://')) {
    throw new Error(`fetchDownloadCounts: baseUrl must use https, got: ${baseUrl}`);
  }

  /** @type {Map<string, number|null>} result for the requested names */
  const out = new Map();

  // De-duplicate to lowercased keys, remembering one original spelling for the
  // request URL. Cached names skip the network entirely.
  const toFetch = new Map(); // lowercased key → original name
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const key = name.toLowerCase();
    if (cache.has(key)) { out.set(key, cache.get(key)); continue; }
    if (!toFetch.has(key)) toFetch.set(key, name);
  }
  if (toFetch.size === 0) return out;

  const scoped   = [];
  const unscoped = [];
  for (const [key, original] of toFetch) {
    (original.startsWith('@') ? scoped : unscoped).push([key, original]);
  }

  const semaphore = new Semaphore(CONCURRENCY);

  /**
   * Stores a resolved count in both the cache and the return map.
   * @param {string} key
   * @param {number|null} value
   */
  function record(key, value) {
    cache.set(key, value);
    out.set(key, value);
  }

  const tasks = [];

  // Bulk path: unscoped packages, up to BULK_CHUNK per request.
  for (const batch of chunk(unscoped, BULK_CHUNK)) {
    tasks.push((async () => {
      const path = batch.map(([, original]) => encodeStatsName(original)).join(',');
      await semaphore.acquire();
      let data;
      try {
        data = await fetchWithRetry(`${baseUrl}/${path}`, { serviceName: 'npm downloads', throwOnError: false });
      } finally {
        semaphore.release();
      }

      // A single-element batch returns the flat point shape ({ downloads,
      // package }) rather than a keyed object; handle both.
      const single = batch.length === 1;
      for (const [key, original] of batch) {
        const entry = single ? data : data?.[original];
        record(key, getDownloadCount(entry));
      }
    })());
  }

  // Point path: scoped packages, one request each.
  for (const [key, original] of scoped) {
    tasks.push((async () => {
      await semaphore.acquire();
      let data;
      try {
        data = await fetchWithRetry(`${baseUrl}/${encodeStatsName(original)}`, { serviceName: 'npm downloads', throwOnError: false });
      } finally {
        semaphore.release();
      }
      record(key, getDownloadCount(data));
    })());
  }

  await Promise.all(tasks);
  return out;
}

/**
 * Clears the in-memory cache. Intended for use in tests only so that each test
 * starts from a clean state and cache hits do not mask fetch behaviour.
 */
function _clearCache() {
  cache.clear();
}

export { fetchDownloadCounts, getDownloadCount, _clearCache };
