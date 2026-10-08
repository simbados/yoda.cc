/**
 * deps.dev (Open Source Insights) findings client.
 * Fetches GOSSIP findings (malicious, pulled, critical vulnerabilities, deprecation,
 * cooldown, low usage) for npm, PyPI, Go, and Cargo packages using the batched
 * `findingsbatch` endpoint. No API key is required.
 * API reference: https://docs.deps.dev/api/v3alpha/#getfindingsbatch
 *
 * Browser-safe — no Node.js imports. Loaded by the web UI via the `web/src` symlink.
 */

import { fetchWithRetry } from "../util/http.js";
import { scoreKey } from "../util/scoreKey.js";

const DEPS_DEV_FINDINGS_URL = "https://api.deps.dev/v3alpha/findingsbatch";

/** Hard API limit: more than 5000 requests in one batch returns HTTP 400. */
const MAX_BATCH_SIZE = 5000;

/** Safety cap on followed `nextPageToken`s per batch so a misbehaving API cannot loop forever. */
const MAX_PAGES_PER_BATCH = 50;

/** Longest reason / alternative string kept from the API (registry-controlled text). */
const MAX_TEXT_LENGTH = 300;

/** Most alternative package names kept per LOW_USAGE finding. */
const MAX_ALTERNATIVES = 5;

/** Maps the depsview PURL type to the deps.dev `system` enum. */
const SYSTEM_BY_PURL_TYPE = { npm: "NPM", pypi: "PYPI", golang: "GO", cargo: "CARGO" };

/** Reverse of SYSTEM_BY_PURL_TYPE, used to rebuild the Map key from the echoed request. */
const PURL_TYPE_BY_SYSTEM = { NPM: "npm", PYPI: "pypi", GO: "golang", CARGO: "cargo" };

/**
 * Strips control characters (C0/C1, incl. ANSI ESC), bidi / directional marks,
 * zero-width characters, line/paragraph separators and the BOM from registry-controlled text, collapses whitespace and truncates it, so the text
 * is safe to print in a terminal and cannot visually reorder surrounding output.
 *
 * Examples:
 *   cleanText("use \x1b[31mfoo\x1b[0m\ninstead")  → "use [31mfoo [0m instead"
 *   cleanText(42)                                 → null
 *
 * @param {unknown} value
 * @param {number} [max=MAX_TEXT_LENGTH]
 * @returns {string|null} cleaned text, or null when the value is not a non-empty string
 */
function cleanText(value, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * Reduces one raw API finding to a whitelisted, sanitised object. Unknown fields
 * are dropped; `type` / `risk` are kept only when they are plain upper-case enums.
 *
 * Example:
 *   sanitizeFinding({ type: "DEPRECATED", risk: "RISK_MEDIUM",
 *                     deprecatedContext: { reason: "use padStart" } })
 *   → { type: "DEPRECATED", risk: "RISK_MEDIUM", reason: "use padStart" }
 *
 * @param {unknown} raw
 * @returns {{ type: string, risk: string|null, reason?: string, until?: string, alternatives?: string[] }|null}
 */
function sanitizeFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = typeof raw.type === "string" && /^[A-Z_]{1,40}$/.test(raw.type) ? raw.type : null;
  if (!type) return null;
  const risk = typeof raw.risk === "string" && /^[A-Z_]{1,40}$/.test(raw.risk) ? raw.risk : null;
  const out = { type, risk };

  const reason = cleanText(raw.deprecatedContext?.reason);
  if (reason) out.reason = reason;

  const until = cleanText(raw.cooldownContext?.end, 40);
  if (until) out.until = until;

  const alternatives = raw.lowUsageContext?.alternativePackages;
  if (Array.isArray(alternatives)) {
    const names = alternatives
      .map((a) => cleanText(a, 214))
      .filter(Boolean)
      .slice(0, MAX_ALTERNATIVES);
    if (names.length) out.alternatives = names;
  }
  return out;
}

/**
 * Sanitises an array of raw findings, dropping anything that is not a valid finding.
 * @param {unknown} list
 * @returns {Array<object>}
 */
function sanitizeFindingList(list) {
  return Array.isArray(list) ? list.map(sanitizeFinding).filter(Boolean) : [];
}

/**
 * Converts one `responses[]` entry of the findingsbatch API into a Map key plus a
 * compact, sanitised findings record. The key is built from the echoed (uncanonicalised)
 * `request.versionKey`, not from `findings.versionKey`, because deps.dev canonicalises
 * names and versions (e.g. PyPI `PyYAML@5.3` comes back as `pyyaml@5.3.0`).
 *
 * Example (abridged):
 *   parseFindingsResponse({
 *     request:  { versionKey: { system: "NPM", name: "minimist", version: "0.0.8" } },
 *     findings: { requestedVersion: { findings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }],
 *                                     cooldownEnd: "2014-03-08T04:46:49Z" },
 *                 packageFindings: [], recommendedVersions: [...] } })
 *   → { key: "npm:minimist@0.0.8",
 *       record: { versionFound: true, versionFindings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }],
 *                 packageFindings: [], cooldownEnd: "2014-03-08T04:46:49Z", recommended: {...}|null } }
 *
 * @param {unknown} entry
 * @returns {{ key: string, record: object }|null} null when the entry cannot be mapped
 */
function parseFindingsResponse(entry) {
  const req = entry?.request?.versionKey;
  if (!req || typeof req !== "object") return null;
  const purlType = PURL_TYPE_BY_SYSTEM[req.system];
  if (!purlType || typeof req.name !== "string" || typeof req.version !== "string") return null;

  const findings = entry.findings && typeof entry.findings === "object" ? entry.findings : {};
  const requested = findings.requestedVersion;
  const versionFound = Boolean(requested && typeof requested === "object");

  const firstRecommended = Array.isArray(findings.recommendedVersions)
    ? findings.recommendedVersions[0]
    : null;
  const recommendedVersion = cleanText(firstRecommended?.versionKey?.version, 100);
  const recommended = recommendedVersion
    ? {
        version: recommendedVersion,
        types: sanitizeFindingList(firstRecommended.findings).map((f) => f.type),
      }
    : null;

  return {
    key: scoreKey(purlType, req.name, req.version),
    record: {
      versionFound,
      versionFindings: versionFound ? sanitizeFindingList(requested.findings) : [],
      packageFindings: sanitizeFindingList(findings.packageFindings),
      cooldownEnd: versionFound ? cleanText(requested.cooldownEnd, 40) : null,
      recommended,
    },
  };
}

/**
 * Builds deps.dev `versionKey` requests for a mixed-ecosystem package list, split into
 * chunks of at most MAX_BATCH_SIZE. Packages with an unsupported ecosystem or a missing
 * version are skipped (the API only accepts exact versions), and duplicates
 * (same ecosystem + case-insensitive name + version) are sent once.
 *
 * Example:
 *   buildFindingsRequests([{ name: "express", version: "4.17.1", ecosystem: "npm" },
 *                          { name: "Express", version: "4.17.1", ecosystem: "npm" }])
 *   → [[{ versionKey: { system: "NPM", name: "express", version: "4.17.1" } }]]
 *
 * @param {Array<{ name: string, version: string, ecosystem: 'npm'|'pypi'|'golang'|'cargo' }>} packages
 * @param {number} [chunkSize=MAX_BATCH_SIZE]
 * @returns {Array<Array<{ versionKey: { system: string, name: string, version: string } }>>}
 */
function buildFindingsRequests(packages, chunkSize = MAX_BATCH_SIZE) {
  const seen = new Set();
  const requests = [];
  for (const { name, version, ecosystem } of packages) {
    const system = SYSTEM_BY_PURL_TYPE[ecosystem];
    if (!system || !name || !version || version === "unknown") continue;
    const key = scoreKey(ecosystem, name, version);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ versionKey: { system, name, version } });
  }
  const chunks = [];
  for (let i = 0; i < requests.length; i += chunkSize) {
    chunks.push(requests.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Sends one batch (and follows its pagination) to the findingsbatch endpoint.
 * The body is sent as `text/plain` so browsers treat it as a CORS "simple request":
 * deps.dev answers the POST with `access-control-allow-origin: *` but rejects the
 * OPTIONS preflight that `application/json` would trigger.
 *
 * @param {Array<object>} requests - one chunk from buildFindingsRequests
 * @param {{ url: string, maxPages: number, retryBaseMs?: number }} opts
 * @returns {Promise<Array<object>>} all `responses[]` entries of all pages (empty on failure)
 */
async function fetchBatch(requests, opts) {
  const all = [];
  let pageToken = "";
  for (let page = 0; page < opts.maxPages; page++) {
    const body = pageToken ? { requests, pageToken } : { requests };
    const data = await fetchWithRetry(opts.url, {
      serviceName: "deps.dev",
      throwOnError: false,
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      responseType: "json",
      ...(opts.retryBaseMs != null ? { retryBaseMs: opts.retryBaseMs } : {}),
    });
    if (!data || !Array.isArray(data.responses)) break;
    all.push(...data.responses);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    if (!pageToken) break;
  }
  return all;
}

/**
 * Fetches deps.dev findings for a mixed batch of packages from every ecosystem.
 * One POST per 5000 packages (normally exactly one), plus any pagination pages.
 *
 * Any failure (network, HTTP error, malformed body) yields an empty or partial Map
 * so callers can treat findings as optional enrichment without breaking the main flow.
 *
 * Example:
 *   const findings = await fetchDepsDevFindings([
 *     { name: "minimist", version: "0.0.8", ecosystem: "npm" },
 *   ]);
 *   findings.get("npm:minimist@0.0.8").versionFindings[0].type  // "VULNERABLE"
 *
 * @param {Array<{ name: string, version: string, ecosystem: 'npm'|'pypi'|'golang'|'cargo' }>} packages
 * @param {{ baseUrl?: string, maxPages?: number, retryBaseMs?: number }} [opts]
 *   opts.baseUrl  - replaces the findingsbatch URL (tests / a future proxy route)
 *   opts.maxPages - pagination safety cap per batch
 * @returns {Promise<Map<string, { versionFound: boolean, versionFindings: object[], packageFindings: object[], cooldownEnd: string|null, recommended: { version: string, types: string[] }|null }>>}
 *   keyed by `${ecosystem}:${name.toLowerCase()}@${version}` (see util/scoreKey.js)
 */
async function fetchDepsDevFindings(packages, opts = {}) {
  const result = new Map();
  if (!Array.isArray(packages) || packages.length === 0) return result;

  try {
    const fetchOpts = {
      url: opts.baseUrl ?? DEPS_DEV_FINDINGS_URL,
      maxPages: opts.maxPages ?? MAX_PAGES_PER_BATCH,
      retryBaseMs: opts.retryBaseMs,
    };
    for (const chunk of buildFindingsRequests(packages)) {
      const responses = await fetchBatch(chunk, fetchOpts);
      for (const entry of responses) {
        const parsed = parseFindingsResponse(entry);
        if (parsed && !result.has(parsed.key)) result.set(parsed.key, parsed.record);
      }
    }
  } catch {
    // fall through with whatever was collected so far
  }
  return result;
}

export {
  fetchDepsDevFindings,
  buildFindingsRequests,
  parseFindingsResponse,
  sanitizeFinding,
  cleanText,
  MAX_BATCH_SIZE,
};
