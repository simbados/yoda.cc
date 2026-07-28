/**
 * Homebrew formula and cask API client.
 * Fetches package metadata from the public formulae.brew.sh JSON API,
 * which is CORS-enabled and requires no authentication.
 * GitHub API calls (update-date lookups) optionally use a personal access
 * token set via setGithubToken() to raise the rate limit from 60 to 5 000/hr.
 */

const FORMULA_API = "https://formulae.brew.sh/api/formula";

/** Currently active GitHub personal access token, or null when unauthenticated. */
let githubToken = null;

/**
 * Sets the GitHub personal access token used for update-date API requests.
 * Pass null to clear the token and revert to unauthenticated requests.
 * @param {string|null} token
 */
export function setGithubToken(token) {
  githubToken = token ?? null;
}
const CASK_API = "https://formulae.brew.sh/api/cask";

/**
 * Encodes a formula or cask name for use in a URL path segment.
 * Preserves @ so that versioned formulae like openssl@3 remain valid.
 * @param {string} name
 * @returns {string}
 */
function apiSafeName(name) {
  return encodeURIComponent(name).replace(/%40/g, "@");
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

/** GitHub login of Homebrew's CI machine account that publishes releases. */
const BREW_TEST_BOT = "BrewTestBot";

/** How many recent commits to scan when locating the latest BrewTestBot commit. */
const COMMIT_PAGE_SIZE = 100;

/**
 * Error raised when the GitHub API responds with a rate-limit status (403/429).
 * A dedicated type lets callers distinguish "rate limited" from ordinary
 * failures and surface a specific message to the user.
 */
export class RateLimitError extends Error {
  constructor(message = "GitHub API rate limit reached") {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Fetches the date a formula was last released by looking up the most recent
 * commit to its Ruby source file made by BrewTestBot.
 *
 * BrewTestBot is Homebrew's CI machine account; it only commits release-related
 * changes (version bumps and bottle publishing), never human style/audit/relabel
 * edits — so its latest commit is a reliable "last released" signal.
 *
 * A commit counts when BrewTestBot is *either* its author or its committer: on
 * some commits it is only the committer (the change was authored by the original
 * PR contributor), on others only the author. The GitHub commits API cannot OR
 * `author` and `committer` server-side, so instead of a filtered query we fetch
 * one page of recent commits and scan it client-side — still a single request.
 *
 * Returns the committer date as an ISO date string (YYYY-MM-DD), or null when the
 * path is missing, the API is unavailable, or no BrewTestBot commit appears in the
 * most recent page (e.g. a niche or recently-renamed formula).
 *
 * Throws a {@link RateLimitError} when GitHub responds 403/429 — the
 * unauthenticated limit (primary 60/hr, or the secondary concurrent-request
 * limit) has been hit. Callers should catch this and surface it to the user
 * rather than silently showing a missing date.
 *
 * Uses the public GitHub commits API — unauthenticated, rate-limited to 60 req/hr.
 * @param {string|null} rubySourcePath - e.g. "Formula/w/wget.rb"
 * @returns {Promise<string|null>}
 * @throws {RateLimitError} when the GitHub API rate limit is exceeded
 */
/** Expected shape for Homebrew ruby_source_path values, e.g. "Formula/w/wget.rb". */
const RUBY_PATH_RE = /^Formula\/[A-Za-z0-9][\w@.+-]*\/[\w@.+-]+\.rb$/;

export async function fetchFormulaLastUpdated(rubySourcePath) {
  if (!rubySourcePath || !RUBY_PATH_RE.test(rubySourcePath)) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/Homebrew/homebrew-core/commits` +
        `?path=${encodeURIComponent(rubySourcePath)}&per_page=${COMMIT_PAGE_SIZE}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
      },
    );
    // 403/429 from GitHub means the rate limit was hit. Raise it distinctly so
    // resolve() can report it instead of letting the date silently go missing.
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError();
    }
    if (!res.ok) return null;
    const commits = await res.json();
    if (!Array.isArray(commits)) return null;

    // Commits come back newest-first; the first BrewTestBot match is the latest.
    const hit = commits.find(
      (c) => c?.author?.login === BREW_TEST_BOT || c?.committer?.login === BREW_TEST_BOT,
    );
    const date = hit?.commit?.committer?.date;
    return date ? date.slice(0, 10) : null;
  } catch (err) {
    // Propagate rate-limit errors so the caller can surface them; ordinary
    // network/parse failures just mean the date is unavailable → null.
    if (err instanceof RateLimitError) throw err;
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

/** Expected shape for Homebrew cask ruby_source_path values, e.g. "Cask/f/firefox.rb". */
const CASK_RUBY_PATH_RE = /^Casks\/[A-Za-z0-9][\w@.+-]*\/[\w@.+-]+\.rb$/;

/**
 * Fetches the date a cask was last updated by looking up the most recent
 * BrewTestBot commit to its Ruby source file in homebrew-cask.
 * Mirrors fetchFormulaLastUpdated() but queries Homebrew/homebrew-cask.
 * @param {string|null} rubySourcePath - e.g. "Cask/f/firefox.rb"
 * @returns {Promise<string|null>}
 * @throws {RateLimitError} when the GitHub API rate limit is exceeded
 */
export async function fetchCaskLastUpdated(rubySourcePath) {
  if (!rubySourcePath || !CASK_RUBY_PATH_RE.test(rubySourcePath)) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/Homebrew/homebrew-cask/commits` +
        `?path=${encodeURIComponent(rubySourcePath)}&per_page=${COMMIT_PAGE_SIZE}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
      },
    );
    if (res.status === 403 || res.status === 429) throw new RateLimitError();
    if (!res.ok) return null;
    const commits = await res.json();
    if (!Array.isArray(commits)) return null;
    const hit = commits.find(
      (c) => c?.author?.login === BREW_TEST_BOT || c?.committer?.login === BREW_TEST_BOT,
    );
    const date = hit?.commit?.committer?.date;
    return date ? date.slice(0, 10) : null;
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    return null;
  }
}
