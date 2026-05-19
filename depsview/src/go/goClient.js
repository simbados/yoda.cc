/**
 * Go module proxy client.
 * Fetches module metadata from the public Go module proxy (proxy.golang.org)
 * which mirrors every public Go module ever fetched by anyone using the proxy.
 * No authentication required.
 *
 * API reference: https://proxy.golang.org/ — implements the GOPROXY protocol.
 */

import { fetchWithRetry } from '../util/http.js';

const PROXY_BASE = 'https://proxy.golang.org';

/**
 * Encodes a Go module path for use in a proxy URL.
 * The Go module proxy protocol requires uppercase ASCII letters to be replaced
 * with an exclamation mark followed by the corresponding lowercase letter.
 * This avoids case-collisions on case-insensitive filesystems used as caches.
 * For example: "github.com/BurntSushi/toml" → "github.com/!burnt!sushi/toml"
 * @param {string} name
 * @returns {string}
 */
export function escapeModulePath(name) {
  return name.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

/**
 * Validates and encodes a Go module path for safe interpolation into a GOPROXY URL.
 * Valid Go module paths contain only alphanumeric characters, dots, hyphens, underscores,
 * tildes, and slashes. Characters like '?', '#', '%', or whitespace cannot appear in a
 * legitimate module path and would break URL semantics if interpolated directly.
 * Returns null if the name fails validation so callers can treat it as "not found".
 * @param {string} name
 * @returns {string|null}
 */
function encodedModulePath(name) {
  if (/[?#%\s"]/.test(name)) return null;
  return escapeModulePath(name);
}

/**
 * Fetches version metadata for a specific module version from the Go proxy.
 * Returns null on 404, network error, unparseable response, or invalid module path.
 * The returned object has at minimum `{ Version, Time }` where `Time` is the
 * ISO-8601 timestamp the version was tagged.
 *
 * When `version` is the special string `'latest'`, the `/@latest` endpoint is
 * used instead of `/@v/latest.info` — the latter is not a valid GOPROXY path.
 *
 * @param {string} name    - module path, e.g. "github.com/gin-gonic/gin"
 * @param {string} version - exact version e.g. "v1.9.1", or the sentinel "latest"
 * @returns {Promise<{ Version: string, Time: string }|null>}
 */
export async function fetchModuleInfo(name, version) {
  const encoded = encodedModulePath(name);
  if (!encoded) return null;
  const url = version === 'latest'
    ? `${PROXY_BASE}/${encoded}/@latest`
    : `${PROXY_BASE}/${encoded}/@v/${encodeURIComponent(version)}.info`;
  const text = await fetchWithRetry(url, {
    serviceName:  'proxy.golang.org',
    throwOnError: false,
    responseType: 'text',
  });
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    if (typeof raw?.Version !== 'string' && typeof raw?.Time !== 'string') return null;
    return { Version: raw.Version ?? null, Time: raw.Time ?? null };
  } catch {
    return null;
  }
}

/**
 * Fetches the list of known versions for a module from the Go proxy.
 * The endpoint returns a newline-delimited list of valid semver tags;
 * pseudo-versions (untagged commits) are omitted by design.
 * Returns an empty array on error, invalid module path, or when the module has no tagged versions.
 * @param {string} name - module path, e.g. "github.com/gin-gonic/gin"
 * @returns {Promise<string[]>}
 */
export async function fetchModuleVersionList(name) {
  const encoded = encodedModulePath(name);
  if (!encoded) return [];
  const url = `${PROXY_BASE}/${encoded}/@v/list`;
  const text = await fetchWithRetry(url, {
    serviceName:  'proxy.golang.org',
    throwOnError: false,
    responseType: 'text',
  });
  if (!text) return [];
  return text.split('\n').map(v => v.trim()).filter(Boolean);
}

/**
 * Fetches the raw go.mod file for a specific module version from the Go proxy.
 * Returns null on 404, network error, invalid module path, or any non-2xx response.
 * Used to discover transitive dependencies declared in the module's own go.mod.
 *
 * @param {string} name    - module path, e.g. "github.com/gin-gonic/gin"
 * @param {string} version - exact version tag, e.g. "v1.9.1" (never "latest")
 * @returns {Promise<string|null>}
 */
export async function fetchModuleMod(name, version) {
  const encoded = encodedModulePath(name);
  if (!encoded) return null;
  const url = `${PROXY_BASE}/${encoded}/@v/${encodeURIComponent(version)}.mod`;
  return fetchWithRetry(url, {
    serviceName:  'proxy.golang.org',
    throwOnError: false,
    responseType: 'text',
  });
}

/**
 * Returns the release date (YYYY-MM-DD) from a module info response.
 * @param {{ Time?: string }|null} info
 * @returns {string} ISO date or "unknown"
 */
export function getReleaseDate(info) {
  return info?.Time ? info.Time.slice(0, 10) : 'unknown';
}
