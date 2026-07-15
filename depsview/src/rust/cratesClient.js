/**
 * crates.io JSON API client.
 *
 * Fetches crate metadata, version metadata, and transitive dependency lists
 * from `https://crates.io/api/v1/crates/...`. No authentication is required
 * for read endpoints, but crates.io's data-access policy rejects requests that
 * do not send an identifying User-Agent (the default Node.js agent gets an HTTP
 * 403), so every request sets one explicitly. This matters for the CLI: in the
 * browser `User-Agent` is a forbidden header and is silently ignored — the
 * browser sends its own agent, which crates.io accepts — so setting it here is
 * a no-op on the web and the identifier is only ever seen for CLI usage.
 *
 * API reference: https://crates.io/data-access
 *
 * Endpoints used:
 *   GET /api/v1/crates/{name}                            crate info + all versions
 *   GET /api/v1/crates/{name}/{version}/dependencies     transitive deps for a version
 */

import { fetchWithRetry } from '../util/http.js';

const CRATES_BASE = 'https://crates.io/api/v1/crates';

/**
 * User-Agent sent on every crates.io request. crates.io's data-access policy
 * requires an identifying agent with a contact URL; requests using the default
 * runtime agent are answered with HTTP 403. Points at the GitHub repo rather
 * than the website because a CLI user (the only runtime where this header is
 * actually applied) is not using the web app.
 */
const CRATES_USER_AGENT = 'depsview (https://github.com/simbados/yoda.cc)';

/** Common request headers for crates.io JSON endpoints. */
const CRATES_HEADERS = { 'Accept': 'application/json', 'User-Agent': CRATES_USER_AGENT };

/**
 * Validates a crate name for safe interpolation into a crates.io URL.
 * Crate names accept only ASCII letters, digits, `-`, and `_`. Returns null
 * when the name fails validation so callers can treat the package as "not
 * found" rather than constructing a malformed URL.
 * @param {string} name
 * @returns {string|null}
 */
function encodedCrateName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  return name;
}

/**
 * Fetches the full crate record for `name` from crates.io.
 *
 * The response object has the shape `{ crate: {...}, versions: [...] }` plus
 * other sibling fields (`keywords`, `categories`, etc.) which we ignore. We
 * normalise the response to `{ crate, versions }` for the resolver's
 * convenience and return null on 404 / invalid name / network error.
 *
 * @param {string} name
 * @returns {Promise<{
 *   crate: { id: string, name: string, repository?: string, max_stable_version?: string, newest_version?: string, max_version?: string, updated_at?: string, recent_downloads?: number },
 *   versions: Array<{ num: string, created_at?: string, yanked?: boolean }>
 * }|null>}
 */
export async function fetchCrateInfo(name) {
  const encoded = encodedCrateName(name);
  if (!encoded) return null;

  const url = `${CRATES_BASE}/${encodeURIComponent(encoded)}`;
  const data = await fetchWithRetry(url, {
    serviceName:  'crates.io',
    throwOnError: false,
    headers:      CRATES_HEADERS,
  });
  if (!data || typeof data !== 'object') return null;

  const crateField = data.crate ?? {};
  const versionsField = Array.isArray(data.versions) ? data.versions : [];
  if (!crateField.name) return null;

  return { crate: crateField, versions: versionsField };
}

/**
 * Fetches the dependency list for a specific crate version from crates.io.
 *
 * The response object has shape `{ dependencies: [{ crate_id, req, kind, optional, ... }] }`.
 * `kind` is one of `"normal"`, `"build"`, `"dev"`. We surface all three so
 * the resolver can choose how to filter; in practice transitive crawling
 * follows only `normal` + `build` (a crate's `dev-dependencies` are not
 * part of its consumers' build graph).
 *
 * Returns an empty array on 404 / invalid name / network error.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Promise<Array<{ crate_id: string, req: string, kind: 'normal'|'build'|'dev', optional: boolean }>>}
 */
export async function fetchCrateVersionDeps(name, version) {
  const encoded = encodedCrateName(name);
  if (!encoded) return [];
  if (typeof version !== 'string' || version.length === 0) return [];

  const url = `${CRATES_BASE}/${encodeURIComponent(encoded)}/${encodeURIComponent(version)}/dependencies`;
  const data = await fetchWithRetry(url, {
    serviceName:  'crates.io',
    throwOnError: false,
    headers:      CRATES_HEADERS,
  });
  if (!data || !Array.isArray(data.dependencies)) return [];

  return data.dependencies.map(d => ({
    crate_id: String(d.crate_id ?? ''),
    req:      String(d.req      ?? ''),
    kind:     d.kind === 'build' || d.kind === 'dev' ? d.kind : 'normal',
    optional: Boolean(d.optional),
  })).filter(d => d.crate_id.length > 0);
}

/**
 * Returns the publication date (YYYY-MM-DD) of a given version from the
 * crates.io versions array. Falls back to `"unknown"` when the version is
 * not in the array or has no `created_at` timestamp.
 * @param {Array<{ num: string, created_at?: string }>} versions
 * @param {string} version
 * @returns {string}
 */
export function getReleaseDate(versions, version) {
  if (!Array.isArray(versions)) return 'unknown';
  const entry = versions.find(v => v.num === version);
  if (!entry?.created_at) return 'unknown';
  return String(entry.created_at).slice(0, 10);
}

/**
 * Returns the date of the earliest published version of a crate (YYYY-MM-DD).
 * Iterates the `versions` array's `created_at` timestamps so we do not depend
 * on the response being in any particular order.
 * Yanked versions are still considered — the question is "when did the crate
 * first appear on crates.io", not "what is its first non-yanked release".
 * @param {Array<{ created_at?: string }>} versions
 * @returns {string}
 */
export function getFirstReleaseDate(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return 'unknown';
  const times = versions.map(v => v.created_at).filter(Boolean).sort();
  return times.length === 0 ? 'unknown' : String(times[0]).slice(0, 10);
}

/**
 * Returns the total number of non-yanked published versions for a crate.
 * Mirrors the popularity-proxy semantics used by the PyPI and Go resolvers.
 * @param {Array<{ yanked?: boolean }>} versions
 * @returns {number}
 */
export function getReleaseCount(versions) {
  if (!Array.isArray(versions)) return 0;
  return versions.filter(v => !v.yanked).length;
}

/**
 * Returns a crate's recent download count as reported by crates.io.
 *
 * crates.io's `recent_downloads` field counts downloads over the **last 90
 * days** (introduced by RFC 1824), which is distinct from the all-time
 * `downloads` field. The value comes free with the crate record fetched by
 * `fetchCrateInfo`, so surfacing it costs no extra request.
 *
 * Returns a non-negative integer, or `null` when the field is missing or not a
 * finite non-negative number — e.g. a brand-new crate that has no recent
 * download aggregate yet. Mirrors the `null`-means-unavailable convention used
 * by the Python download-stats path so the shared formatter renders a dash.
 *
 * @param {{ recent_downloads?: number }} crate - the `crate` object from fetchCrateInfo
 * @returns {number|null}
 */
export function getRecentDownloads(crate) {
  if (!crate || typeof crate !== 'object') return null;
  const value = crate.recent_downloads;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Returns the version-number strings (`v.num`) from a crates.io versions
 * array, excluding yanked entries. Order is preserved.
 * @param {Array<{ num: string, yanked?: boolean }>} versions
 * @returns {string[]}
 */
export function getVersionList(versions) {
  if (!Array.isArray(versions)) return [];
  return versions.filter(v => !v.yanked && typeof v.num === 'string').map(v => v.num);
}
