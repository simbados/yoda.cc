/**
 * Homebrew formula and cask API client.
 * Fetches package metadata from the public formulae.brew.sh JSON API,
 * which is CORS-enabled and requires no authentication.
 */

const FORMULA_API = 'https://formulae.brew.sh/api/formula';
const CASK_API    = 'https://formulae.brew.sh/api/cask';

/**
 * Encodes a formula or cask name for use in a URL path segment.
 * Preserves @ so that versioned formulae like openssl@3 remain valid.
 * @param {string} name
 * @returns {string}
 */
function apiSafeName(name) {
  return encodeURIComponent(name).replace(/%40/g, '@');
}

/**
 * Fetches the JSON metadata for a Homebrew formula.
 * Throws an Error with a human-readable message on 404 or any non-OK status.
 * @param {string} name - formula name, e.g. "wget" or "openssl@3"
 * @returns {Promise<object>} raw formula JSON from formulae.brew.sh
 */
export async function fetchFormula(name) {
  const res = await fetch(`${FORMULA_API}/${apiSafeName(name)}.json`);
  if (res.status === 404) throw new Error(`Formula not found: ${name}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching formula "${name}"`);
  return res.json();
}

/**
 * Fetches the date of the most recent commit to a formula's Ruby source file
 * in the homebrew-core repository, which corresponds to when that formula's
 * version was last bumped. Returns an ISO date string (YYYY-MM-DD) or null
 * when the path is missing, the API is unavailable, or the response is empty.
 * Uses the public GitHub commits API — unauthenticated, rate-limited to 60 req/hr.
 * @param {string|null} rubySourcePath - e.g. "Formula/w/wget.rb"
 * @returns {Promise<string|null>}
 */
export async function fetchFormulaLastUpdated(rubySourcePath) {
  if (!rubySourcePath) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/Homebrew/homebrew-core/commits` +
      `?path=${encodeURIComponent(rubySourcePath)}&per_page=1`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) return null;
    const [commit] = await res.json();
    const date = commit?.commit?.author?.date;
    return date ? date.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the JSON metadata for a Homebrew cask.
 * Throws an Error with a human-readable message on 404 or any non-OK status.
 * @param {string} token - cask token, e.g. "firefox"
 * @returns {Promise<object>} raw cask JSON from formulae.brew.sh
 */
export async function fetchCask(token) {
  const res = await fetch(`${CASK_API}/${apiSafeName(token)}.json`);
  if (res.status === 404) throw new Error(`Cask not found: ${token}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching cask "${token}"`);
  return res.json();
}
