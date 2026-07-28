/**
 * Cloudflare Worker: transparent CORS proxy.
 *
 * Handles two routes:
 *
 *   POST /{orgSlug}/purl  — forwards to api.socket.dev (supply chain scores).
 *     The browser sends its own Authorization header; the Worker forwards it
 *     verbatim without storing or logging the API key.
 *
 *   GET /pypistats/packages/{package}/recent  — forwards to pypistats.org.
 *     No authentication is required. pypistats.org does not emit CORS headers,
 *     so this proxy adds them so the browser can read the download stats.
 *
 * All responses carry CORS headers restricted to the allowed origins below.
 */

const UPSTREAM_BASE = "https://api.socket.dev/v0/orgs";
const PYPISTATS_BASE = "https://pypistats.org/api/packages";

/** Matches /pypistats/packages/{package}/recent — package name is capture group 1. */
const PYPISTATS_ROUTE = /^\/pypistats\/packages\/([A-Za-z0-9][A-Za-z0-9._-]*)\/recent$/;

/** Matches /{orgSlug}/purl — slug must start with alphanumeric to block .. traversal. */
const SOCKET_ROUTE = /^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\/purl$/;

const ALLOWED_ORIGINS = new Set([
  "https://deps.yoda.cc",
  "http://localhost",
  "http://localhost:8080",
]);

/**
 * Returns CORS headers for an allowed origin, or null if the origin is not
 * permitted. Access-Control-Allow-Origin must be a single value, so the
 * incoming Origin is echoed back only when it is in the allowlist.
 * @param {string|null} origin
 * @returns {Record<string, string>}
 */
function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://deps.yoda.cc";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Proxies a GET request to pypistats.org and returns the response with CORS headers.
 * The package name has already been validated by the caller via PYPISTATS_ROUTE.
 * @param {string} packageName - normalised PyPI package name
 * @param {Record<string,string>} cors - pre-built CORS headers for this request's origin
 * @returns {Promise<Response>}
 */
async function handlePypistats(packageName, cors) {
  const target = `${PYPISTATS_BASE}/${packageName}/recent`;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: cors });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    console.error("pypistats upstream returned unexpected redirect:", upstream.status);
    return new Response("Bad Gateway", { status: 502, headers: cors });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      ...cors,
    },
  });
}

/**
 * Proxies a POST request to api.socket.dev and returns the response with CORS headers.
 * The path has already been validated by the caller via SOCKET_ROUTE.
 * @param {Request} request - original browser request
 * @param {URL} url - parsed URL of the request
 * @param {Record<string,string>} cors - pre-built CORS headers for this request's origin
 * @returns {Promise<Response>}
 */
async function handleSocket(request, url, cors) {
  // Hard-code the query string to prevent callers from injecting arbitrary
  // query parameters to the upstream API.
  const PURL_QUERY =
    "?alerts=false&compact=false&fixable=false&licenseattrib=false" +
    "&licensedetails=false&purlErrors=false&poll=false" +
    "&cachedResultsOnly=false&summary=false";
  const target = `${UPSTREAM_BASE}${url.pathname}${PURL_QUERY}`;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
        "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        Accept: request.headers.get("Accept") ?? "application/x-ndjson",
      },
      body: request.body,
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: cors });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    console.error("socket upstream returned unexpected redirect:", upstream.status);
    return new Response("Bad Gateway", { status: 502, headers: cors });
  }

  // Stream without buffering — the NDJSON payload can be many megabytes.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/x-ndjson",
      ...cors,
    },
  });
}

export default {
  /**
   * Entry point for all incoming requests.
   * Routes:
   *   OPTIONS              → CORS preflight (204)
   *   GET  /pypistats/...  → pypistats.org proxy
   *   POST /{slug}/purl    → socket.dev proxy
   *   anything else        → 404 / 405
   *
   * @param {Request} request - Cloudflare Workers Request object
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === "GET") {
      const m = url.pathname.match(PYPISTATS_ROUTE);
      if (m) return handlePypistats(m[1], cors);
      return new Response("Not Found", { status: 404, headers: cors });
    }

    if (request.method === "POST") {
      if (!SOCKET_ROUTE.test(url.pathname)) {
        return new Response("Not Found", { status: 404, headers: cors });
      }
      return handleSocket(request, url, cors);
    }

    return new Response("Method Not Allowed", { status: 405, headers: cors });
  },
};
