/**
 * Socket.dev API client.
 * Fetches supply chain security scores for npm, PyPI, and Go packages in a
 * single batched POST request using Package URL (PURL) identifiers.
 * API reference: https://docs.socket.dev/reference/batchpackagefetchbyorg
 */

import { fetchWithRetry } from "../util/http.js";

const SOCKET_API = "https://api.socket.dev/v0/orgs";

/**
 * Builds a Package URL (PURL) string for a given package.
 * The PURL type for Python on socket.dev is `pypi`, for Node.js is `npm`,
 * and for Go modules is `golang`.
 * @param {string} name       - package name (e.g. "express" or "@esbuild/aix-ppc64")
 * @param {string} version    - exact version string
 * @param {'npm'|'pypi'|'golang'} ecosystem - PURL type
 * @returns {string} e.g. "pkg:npm/express@4.19.2" or "pkg:golang/github.com/gin-gonic/gin@v1.9.1"
 */
function buildPurl(name, version, ecosystem) {
  return `pkg:${ecosystem}/${name}@${version}`;
}

/**
 * Parses a PURL string back into its component fields.
 * Format: pkg:<type>/<name>@<version> (where <name> may itself contain slashes
 * for hierarchical names like Go module paths or scoped npm packages).
 * Returns null when the string does not look like a PURL.
 * @param {string} purl
 * @returns {{ type: string, name: string, version: string }|null}
 */
function parsePurl(purl) {
  if (typeof purl !== "string" || !purl.startsWith("pkg:")) return null;
  const body = purl.slice(4);
  const at = body.lastIndexOf("@");
  if (at === -1) return null;
  const version = body.slice(at + 1);
  const slash = body.indexOf("/");
  if (slash === -1) return null;
  const type = body.slice(0, slash);
  const name = body.slice(slash + 1, at);
  if (!type || !name || !version) return null;
  return { type, name, version };
}

/**
 * Parses a newline-delimited JSON (NDJSON) string into an array of objects.
 * Each non-empty line is parsed independently; malformed lines are silently
 * skipped rather than aborting the whole parse.
 * @param {string} text - raw NDJSON response body
 * @returns {Array<object>}
 */
function parseNdjson(text) {
  const results = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}

/**
 * Builds the canonical Map key for an ecosystem-tagged package + version pair.
 * Used both when ingesting the socket response and when looking up scores from
 * the formatter / report, so the two sides stay aligned.
 * @param {string} ecosystem - PURL type (`npm`, `pypi`, `golang`)
 * @param {string} name      - package name
 * @param {string} version
 * @returns {string}
 */
function scoreKey(ecosystem, name, version) {
  return `${ecosystem}:${name.toLowerCase()}@${version}`;
}

/**
 * Fetches supply chain security scores for a mixed batch of packages from socket.dev.
 * All packages from every ecosystem are sent in a single POST request to stay within
 * API quota. Each input item carries its own PURL type so the request can mix
 * `pkg:npm/...`, `pkg:pypi/...`, and `pkg:golang/...` entries in one call.
 *
 * Any failure (network, auth, parse error) returns an empty Map so callers can
 * treat scores as optional enrichment without breaking the main flow.
 *
 * @param {Array<{ name: string, version: string, ecosystem: 'npm'|'pypi'|'golang' }>} packages
 * @param {string} apiKey  - Socket.dev API key (Bearer token)
 * @param {string} orgSlug - Socket.dev organisation slug
 * @param {{ proxyBase?: string }} [opts]
 *   opts.proxyBase - when provided, replaces `https://api.socket.dev/v0/orgs` as the
 *                    API base URL. Use this to route browser requests through a
 *                    self-hosted Cloudflare Worker CORS proxy, e.g.
 *                    `https://socket-proxy.example.workers.dev`. The org slug is
 *                    still appended automatically.
 * @returns {Promise<Map<string, number>>} Map keyed by `${ecosystem}:${name.toLowerCase()}@${version}` → supplyChain score (0–1)
 */
async function fetchSocketScores(packages, apiKey, orgSlug, opts = {}) {
  if (packages.length === 0) return new Map();

  try {
    const components = packages.map(({ name, version, ecosystem }) => ({
      purl: buildPurl(name, version, ecosystem),
    }));

    // compact=false is required — compact mode strips the score field from responses.
    // The API emits one line per release artifact (tar-gz, wheel, …) for the same
    // package version, so we skip any key already written to avoid redundant writes.
    const apiBase = opts.proxyBase ?? SOCKET_API;
    const url =
      `${apiBase}/${encodeURIComponent(orgSlug)}/purl` +
      "?alerts=false&compact=false&fixable=false&licenseattrib=false" +
      "&licensedetails=false&purlErrors=false&poll=false" +
      "&cachedResultsOnly=false&summary=false";

    const text = await fetchWithRetry(url, {
      serviceName: "socket.dev",
      throwOnError: false,
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ components }),
      responseType: "text",
    });

    if (!text) return new Map();

    const scores = new Map();
    for (const obj of parseNdjson(text)) {
      if (obj.score?.supplyChain == null) continue;

      // Prefer the echoed PURL when present — it preserves the original ecosystem
      // tag we sent. Fall back to assembling from type/namespace/name fields.
      let ecosystem, fullName, version;
      const parsed = parsePurl(obj.purl);
      if (parsed) {
        ({ type: ecosystem, name: fullName, version } = parsed);
      } else if (obj.type && obj.name && obj.version) {
        ecosystem = obj.type;
        fullName = obj.namespace ? `${obj.namespace}/${obj.name}` : obj.name;
        version = obj.version;
      } else {
        continue;
      }

      const key = scoreKey(ecosystem, fullName, version);
      if (!scores.has(key)) scores.set(key, obj.score.supplyChain);
    }
    return scores;
  } catch {
    return new Map();
  }
}

export { fetchSocketScores, buildPurl, parsePurl, parseNdjson, scoreKey };
