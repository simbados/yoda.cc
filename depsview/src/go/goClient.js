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
 * Fetches version metadata for a specific module version from the Go proxy.
 * Returns null on 404, network error, or unparseable response.
 * The returned object has at minimum `{ Version, Time }` where `Time` is the
 * ISO-8601 timestamp the version was tagged.
 * @param {string} name    - module path, e.g. "github.com/gin-gonic/gin"
 * @param {string} version - exact version, e.g. "v1.9.1"
 * @returns {Promise<{ Version: string, Time: string }|null>}
 */
export async function fetchModuleInfo(name, version) {
  const url = `${PROXY_BASE}/${escapeModulePath(name)}/@v/${encodeURIComponent(version)}.info`;
  const text = await fetchWithRetry(url, {
    serviceName:  'proxy.golang.org',
    throwOnError: false,
    responseType: 'text',
  });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fetches the list of known versions for a module from the Go proxy.
 * The endpoint returns a newline-delimited list of valid semver tags;
 * pseudo-versions (untagged commits) are omitted by design.
 * Returns an empty array on error or when the module has no tagged versions.
 * @param {string} name - module path, e.g. "github.com/gin-gonic/gin"
 * @returns {Promise<string[]>}
 */
export async function fetchModuleVersionList(name) {
  const url = `${PROXY_BASE}/${escapeModulePath(name)}/@v/list`;
  const text = await fetchWithRetry(url, {
    serviceName:  'proxy.golang.org',
    throwOnError: false,
    responseType: 'text',
  });
  if (!text) return [];
  return text.split('\n').map(v => v.trim()).filter(Boolean);
}

/**
 * Returns the release date (YYYY-MM-DD) from a module info response.
 * @param {{ Time?: string }|null} info
 * @returns {string} ISO date or "unknown"
 */
export function getReleaseDate(info) {
  return info?.Time ? info.Time.slice(0, 10) : 'unknown';
}
