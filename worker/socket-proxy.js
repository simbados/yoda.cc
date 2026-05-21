/**
 * Cloudflare Worker: transparent CORS proxy for the socket.dev PURL batch API.
 *
 * The browser cannot call api.socket.dev directly because that API does not
 * emit CORS headers. This Worker sits in between: the browser sends its POST
 * request here (with its own Authorization header), the Worker forwards it to
 * socket.dev, and returns the response with the necessary CORS headers.
 *
 * The API key travels in the browser's Authorization header and is forwarded
 * verbatim — it is never stored in the Worker or in any environment variable.
 *
 * Only POST requests to paths matching /{orgSlug}/purl are accepted, limiting
 * the proxy surface to exactly the one endpoint the browser needs. Responses
 * are restricted to the origin https://deps.yoda.cc via CORS headers.
 */

const UPSTREAM_BASE = 'https://api.socket.dev/v0/orgs';

const ALLOWED_ORIGINS = new Set([
  'https://deps.yoda.cc',
  'http://localhost',
  'http://localhost:8080',
]);

/**
 * Returns CORS headers for an allowed origin, or null if the origin is not
 * permitted. Access-Control-Allow-Origin must be a single value, so the
 * incoming Origin is echoed back only when it is in the allowlist.
 * @param {string|null} origin
 * @returns {Record<string, string>}
 */
function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://deps.yoda.cc';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age':       '86400',
  };
}

export default {
  /**
   * Entry point for all incoming requests.
   * Routes OPTIONS to a CORS preflight handler and POST to the proxy handler.
   * All other methods receive 405 Method Not Allowed.
   *
   * @param {Request} request - Cloudflare Workers Request object
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const cors   = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const url = new URL(request.url);

    // Restrict to /{orgSlug}/purl only. The slug must start with an alphanumeric
    // character so that dot-only values (`.`, `..`) cannot slip through even if a
    // URL-normalisation assumption ever breaks: `..` in a fetch() target URL would
    // be normalised to an unintended path on api.socket.dev (proven via new URL()).
    if (!/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\/purl$/.test(url.pathname)) {
      return new Response('Not Found', { status: 404, headers: cors });
    }

    // Hard-code the query string instead of forwarding url.search to prevent
    // callers from passing arbitrary query parameters to the upstream API.
    const PURL_QUERY =
      '?alerts=false&compact=false&fixable=false&licenseattrib=false' +
      '&licensedetails=false&purlErrors=false&poll=false' +
      '&cachedResultsOnly=false&summary=false';
    const target = `${UPSTREAM_BASE}${url.pathname}${PURL_QUERY}`;

    const authHeader = request.headers.get('Authorization') ?? '';

    let upstream;
    try {
      upstream = await fetch(target, {
        method:   'POST',
        redirect: 'manual',
        headers: {
          'Authorization': authHeader,
          'Content-Type':  request.headers.get('Content-Type') ?? 'application/json',
          'Accept':        request.headers.get('Accept')       ?? 'application/x-ndjson',
        },
        body: request.body,
      });
    } catch (err) {
      return new Response('Bad Gateway', { status: 502, headers: cors });
    }

    // Reject redirects — prevents SSRF if the upstream ever returns a 3xx.
    // redirect: 'manual' is used because CF Workers does not support 'error'.
    if (upstream.status >= 300 && upstream.status < 400) {
      console.error('upstream returned unexpected redirect:', upstream.status);
      return new Response('Bad Gateway', { status: 502, headers: cors });
    }

    // Stream the response body through without buffering — avoids loading the
    // full NDJSON payload (potentially megabytes for large batches) into memory.
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/x-ndjson', ...cors },
    });
  },
};
