/**
 * Browser entry point for depsview.
 * Wires the HTML form to the dependency-resolution pipeline and renders one
 * section per detected ecosystem. All HTTP calls go directly to the GitHub
 * Contents API, the PyPI / npm registry APIs, and proxy.golang.org from the
 * browser — no server-side component.
 *
 * Ecosystem auto-detection: after the GitHub root directory is listed, every
 * ecosystem whose dependency files are present produces its own section. The
 * fixed render order is npm → python → go.
 *
 * Pure utility functions are exported for testing with the Node.js test runner
 * without a DOM. DOM-manipulation code runs only when `document` is available.
 */

import { parseGithubUrl               } from './src/github/url.js';
import { parseGithubDependencies,
         parseGithubNpmDependencies,
         parseGithubGoDependencies    } from './src/github/parser.js';
import { resolveDependencies          } from './src/python/depResolver.js';
import { resolveDependencies as resolveNpm } from './src/npm/depResolver.js';
import { resolveDependencies as resolveGo  } from './src/go/depResolver.js';
import { setGithubToken               } from './src/github/client.js';
import { listDirectory                } from './src/github/client.js';

/** Fixed rendering order for ecosystem sections. */
export const ECOSYSTEM_ORDER = ['npm', 'python', 'go'];

// ── Pure utility functions (exported for testing) ─────────────────────────────

/**
 * Formats an integer with locale-aware thousand separators (e.g. 1234 → "1,234").
 * Returns "–" when the value is null or undefined.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n == null) return '–';
  return n.toLocaleString();
}

/**
 * Returns the number of whole days elapsed between today and an ISO date string.
 * Returns Infinity for "unknown" or unparseable dates so those entries sort last.
 * @param {string|null|undefined} dateStr
 * @returns {number}
 */
export function daysSince(dateStr) {
  if (!dateStr || dateStr === 'unknown') return Infinity;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms)) return Infinity;
  return Math.floor(ms / 86_400_000);
}

/**
 * Sorts a Map of resolved dependency results by an arbitrary column.
 * "unknown" date strings and null numeric values always sink to the bottom
 * regardless of direction. String columns use localeCompare; date columns compare
 * ISO-8601 strings lexicographically; numeric columns compare by value.
 * All sorts use name as a tiebreaker.
 * @param {Map<string, object>} resultsMap
 * @param {'name'|'version'|'releaseDate'|'firstReleaseDate'|'releaseCount'|'downloadsLastMonth'|'supplyChain'} column
 * @param {'asc'|'desc'} direction
 * @returns {Array<object>}
 */
export function sortResultsBy(resultsMap, column, direction) {
  const sign   = direction === 'asc' ? 1 : -1;
  const isDate = column === 'releaseDate' || column === 'firstReleaseDate';
  const isNum  = column === 'releaseCount' || column === 'downloadsLastMonth' || column === 'supplyChain';

  return [...resultsMap.values()].sort((a, b) => {
    const aVal = a[column] ?? (isDate ? 'unknown' : null);
    const bVal = b[column] ?? (isDate ? 'unknown' : null);

    if (isDate) {
      const aUnk = aVal === 'unknown';
      const bUnk = bVal === 'unknown';
      if (aUnk && bUnk) return a.name.localeCompare(b.name);
      if (aUnk) return 1;
      if (bUnk) return -1;
      const cmp = aVal.localeCompare(bVal);
      return cmp !== 0 ? sign * cmp : a.name.localeCompare(b.name);
    }

    if (isNum) {
      const aNull = aVal == null;
      const bNull = bVal == null;
      if (aNull && bNull) return a.name.localeCompare(b.name);
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = aVal - bVal;
      return cmp !== 0 ? sign * cmp : a.name.localeCompare(b.name);
    }

    const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
    return cmp !== 0 ? sign * cmp : 0;
  });
}

/**
 * Sorts a Map of resolved dependency results by release date, newest first.
 * "unknown" dates sink to the bottom, sorted alphabetically among themselves.
 * Does not mutate the input Map.
 * @param {Map<string, object>} resultsMap
 * @returns {Array<object>}
 */
export function sortResults(resultsMap) {
  return sortResultsBy(resultsMap, 'releaseDate', 'desc');
}

/**
 * Returns the set of ecosystems whose dependency files appear in a directory listing.
 * @param {Array<{ name: string, type: string }>} listing
 * @returns {Set<'npm'|'python'|'go'>}
 */
export function detectEcosystems(listing) {
  const names = new Set(listing.map(e => e.name));
  const found = new Set();
  if (names.has('package-lock.json') || names.has('pnpm-lock.yaml') || names.has('package.json')) found.add('npm');
  if (names.has('go.sum') || names.has('go.mod'))                                                 found.add('go');
  if (names.has('pyproject.toml')   || names.has('requirements.txt') ||
      names.has('requirements_all.txt') ||
      names.has('setup.cfg')        || names.has('Pipfile') ||
      names.has('manifest.json'))                                                                 found.add('python');
  return found;
}

/**
 * Legacy single-ecosystem detection retained for backwards compatibility with
 * older tests. Returns the first detected ecosystem in priority order
 * (npm → go → python) or null when none are found.
 * @param {Array<{ name: string, type: string }>} listing
 * @returns {'npm'|'go'|'python'|null}
 */
export function detectEcosystem(listing) {
  const set = detectEcosystems(listing);
  if (set.has('npm'))    return 'npm';
  if (set.has('go'))     return 'go';
  if (set.has('python')) return 'python';
  return null;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Appends a `<td>` cell with text content to a row and returns it.
 * Uses textContent to prevent XSS from API-sourced package names.
 * @param {HTMLTableRowElement} row
 * @param {string} text
 * @returns {HTMLTableCellElement}
 */
function addCell(row, text) {
  const td = row.insertCell();
  td.textContent = text;
  return td;
}

/**
 * Renders one ecosystem section (heading + summary + sortable table) into the
 * given container. Returns the section element so the caller can attach
 * per-section sort handlers.
 *
 * Column visibility:
 *   - First Release: shown unless `ecosystem === 'go'`.
 *   - Releases:      always shown.
 *
 * @param {HTMLElement} container
 * @param {object}      cfg
 * @param {'npm'|'python'|'go'} cfg.ecosystem
 * @param {boolean}     cfg.showHeader        - emit a section title above the table
 * @param {Array<object>} cfg.sorted          - already-sorted rows from sortResultsBy
 * @param {number}      cfg.directCount       - 0 when unknown (lock-file resolution)
 * @param {string|null} cfg.source            - dependency file name
 * @param {string|null} cfg.note              - informational note (e.g. pnpm-lock v9)
 * @param {string|null} cfg.sortCol           - current sort column for sort indicators
 * @param {string|null} cfg.sortDir           - 'asc' or 'desc'
 * @returns {HTMLElement} the section element
 */
function renderSection(container, cfg) {
  const sectionEl = document.createElement('section');
  sectionEl.className = 'result-section';
  sectionEl.dataset.ecosystem = cfg.ecosystem;

  if (cfg.showHeader) {
    const h2 = document.createElement('h2');
    h2.className = 'section-title';
    h2.textContent = cfg.ecosystem;
    sectionEl.appendChild(h2);
  }

  const total = cfg.sorted.length;
  const summary = document.createElement('p');
  summary.className = 'summary';
  if (cfg.directCount > 0) {
    const transitiveCount = total - cfg.directCount;
    summary.textContent = `${total} package${total !== 1 ? 's' : ''} total (${cfg.directCount} direct, ${transitiveCount} transitive)`;
  } else {
    summary.textContent = `${total} package${total !== 1 ? 's' : ''} total`;
  }
  sectionEl.appendChild(summary);

  if (cfg.source) {
    const sourceEl = document.createElement('p');
    sourceEl.className = 'source-files';
    sourceEl.textContent = `Files: ${cfg.source}`;
    sectionEl.appendChild(sourceEl);
  }

  if (cfg.note) {
    const noteEl = document.createElement('p');
    noteEl.className = 'note note-warning';
    noteEl.textContent = `ⓘ ${cfg.note}`;
    sectionEl.appendChild(noteEl);
  }

  if (total === 0) {
    const msg = document.createElement('p');
    msg.textContent = 'No dependencies found.';
    sectionEl.appendChild(msg);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  const showFirst = cfg.ecosystem !== 'go';

  const table = document.createElement('table');
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  const COL_DEFS = [
    ['Package',  'name'],
    ['Version',  'version'],
    ['Released', 'releaseDate'],
  ];
  if (showFirst) COL_DEFS.push(['First Release', 'firstReleaseDate']);
  COL_DEFS.push(['Releases', 'releaseCount']);

  for (const [label, col] of COL_DEFS) {
    const th = document.createElement('th');
    th.textContent = label;
    th.dataset.col = col;
    if (col === cfg.sortCol) th.classList.add(`th-sort-${cfg.sortDir}`);
    headerRow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const pkg of cfg.sorted) {
    const tr = tbody.insertRow();

    const nameTd = tr.insertCell();
    const a = document.createElement('a');
    a.href   = pkg.link ?? `https://pypi.org/project/${pkg.name}/`;
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    a.textContent = pkg.name;
    nameTd.appendChild(a);

    if (pkg.error) {
      tr.className = 'row-error';
      const td = addCell(tr, pkg.version ?? 'error');
      td.colSpan = COL_DEFS.length - 1;
      td.title = pkg.error;
      continue;
    }

    addCell(tr, pkg.version);

    // Red (.age-new) when < 7 days, yellow (.age-fresh) when < 30 days.
    // Same logic for both date columns. Strict `<` so dates that are literally
    // a week / month old aren't flagged.
    const relCell = addCell(tr, pkg.releaseDate ?? 'unknown');
    const relAge = daysSince(pkg.releaseDate);
    if (relAge < 7)       relCell.className = 'age-new';
    else if (relAge < 30) relCell.className = 'age-fresh';

    if (showFirst) {
      const firstCell = addCell(tr, pkg.firstReleaseDate ?? 'unknown');
      const firstAge = daysSince(pkg.firstReleaseDate);
      if (firstAge < 7)       firstCell.className = 'age-new';
      else if (firstAge < 30) firstCell.className = 'age-fresh';
    }

    addCell(tr, formatNumber(pkg.releaseCount ?? 0));
  }

  sectionEl.appendChild(table);
  container.appendChild(sectionEl);
  return sectionEl;
}

/**
 * Renders one section into an error banner. Used when a single ecosystem's
 * parse / resolve threw — the other sections still render normally.
 * @param {HTMLElement} container
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {string} message
 * @param {boolean} showHeader
 */
function renderSectionError(container, ecosystem, message, showHeader) {
  const sectionEl = document.createElement('section');
  sectionEl.className = 'result-section';
  if (showHeader) {
    const h2 = document.createElement('h2');
    h2.className = 'section-title';
    h2.textContent = ecosystem;
    sectionEl.appendChild(h2);
  }
  const errorEl = document.createElement('p');
  errorEl.className = 'note note-warning';
  errorEl.textContent = `ⓘ [${ecosystem}] ${message}`;
  sectionEl.appendChild(errorEl);
  container.appendChild(sectionEl);
}

// ── Per-ecosystem parse + resolve (browser side) ──────────────────────────────

/**
 * Runs the parse → resolve pipeline for one ecosystem against a GitHub ref.
 * Returns the section's data needed to render it: deps, resolved results,
 * direct dep names, source filename, and any note.
 *
 * @param {'npm'|'python'|'go'} ecosystem
 * @param {object} githubRef
 * @param {{ includeTests: boolean, onProgress: (msg: string) => void }} opts
 * @returns {Promise<object>}
 */
async function resolveEcosystem(ecosystem, githubRef, opts) {
  const { includeTests, onProgress } = opts;

  let deps, source, note = null;
  if (ecosystem === 'npm') {
    ({ deps, source, note } = await parseGithubNpmDependencies(githubRef, { includeTests }));
  } else if (ecosystem === 'go') {
    ({ deps, source } = await parseGithubGoDependencies(githubRef));
  } else {
    ({ deps, source } = await parseGithubDependencies(githubRef, { includeTests }));
  }

  const isLockFile = source === 'package-lock.json' || source === 'pnpm-lock.yaml' || source === 'go.sum';
  onProgress(`[${ecosystem}] Found ${deps.length} ${isLockFile ? 'installed' : 'direct'} dep${deps.length === 1 ? '' : 's'} in ${source}. Resolving…\n`);

  let results;
  if (ecosystem === 'npm') {
    results = await resolveNpm(deps, { onProgress: (msg) => onProgress(`[npm] ${msg}\n`) });
  } else if (ecosystem === 'go') {
    results = await resolveGo(deps, { onProgress: (msg) => onProgress(`[go] ${msg}\n`) });
  } else {
    results = await resolveDependencies(deps, { onProgress: (msg) => onProgress(`[python] ${msg}\n`) });
  }

  // Direct-count computation (post-resolution so the names line up):
  // - Lock files: npm = unknown (need package.json), go.sum = unknown (need go.mod)
  // - package.json / go.mod / requirements.txt etc.: every parsed dep is direct,
  //   except go.mod where `// indirect` deps are explicitly flagged.
  let directCount = 0;
  if (ecosystem === 'npm') {
    if (!isLockFile) {
      const directNames = new Set(deps.map(d => d.name.toLowerCase()));
      directCount = [...results.values()].filter(r => directNames.has(r.name.toLowerCase())).length;
    }
  } else if (ecosystem === 'go') {
    if (source === 'go.mod') {
      const directNames = new Set(deps.filter(d => !d.indirect).map(d => d.name.toLowerCase()));
      directCount = [...results.values()].filter(r => directNames.has(r.name.toLowerCase())).length;
    }
  } else {
    const directNames = new Set(deps.map(d => d.name.toLowerCase()));
    directCount = [...results.values()].filter(r => directNames.has(r.name.toLowerCase())).length;
  }

  return { ecosystem, deps, results, directCount, source, note };
}

// ── Browser initialisation ────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
  const form            = document.getElementById('form');
  const urlInput        = document.getElementById('url-input');
  const tokenInput      = document.getElementById('token-input');
  const rememberTokenCb = document.getElementById('remember-token');
  const storageNote     = document.getElementById('storage-note');
  const includeTestsCb  = document.getElementById('include-tests');
  const submitBtn       = document.getElementById('submit-btn');
  const errorDiv        = document.getElementById('error');
  const progressDiv     = document.getElementById('progress');
  const resultsDiv      = document.getElementById('results');

  const TOKEN_STORAGE_KEY = 'depsview.github_token';

  function syncStorageNote() {
    storageNote.hidden = !rememberTokenCb.checked;
  }

  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (savedToken) {
    tokenInput.value      = savedToken;
    rememberTokenCb.checked = true;
    syncStorageNote();
  }

  rememberTokenCb.addEventListener('change', () => {
    syncStorageNote();
    if (rememberTokenCb.checked) {
      const token = tokenInput.value.trim();
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  });

  function appendProgress(text) {
    progressDiv.hidden = false;
    progressDiv.textContent += text;
    progressDiv.scrollTop = progressDiv.scrollHeight;
  }

  function showError(message) {
    errorDiv.textContent = message;
    errorDiv.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorDiv.hidden    = true;
    errorDiv.textContent = '';
    progressDiv.hidden = true;
    progressDiv.textContent = '';
    resultsDiv.hidden  = true;
    resultsDiv.innerHTML = '';

    const url          = urlInput.value.trim();
    const token        = tokenInput.value.trim();
    const includeTests = includeTestsCb.checked;

    if (rememberTokenCb.checked && token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    setGithubToken(token || null);

    let githubRef;
    try {
      githubRef = parseGithubUrl(url);
    } catch (err) {
      showError(err.message);
      return;
    }

    submitBtn.disabled = true;
    appendProgress('Detecting ecosystems…\n');

    try {
      const listing = await listDirectory(githubRef.owner, githubRef.repo, githubRef.subpath, githubRef.ref);
      let ecosystems = detectEcosystems(listing ?? []);
      // Fall back to 'python' so the depth-2 traversal still gets a chance
      // (covers HA-style nested manifest.json layouts).
      if (ecosystems.size === 0) ecosystems = new Set(['python']);

      const ordered = ECOSYSTEM_ORDER.filter(eco => ecosystems.has(eco));
      appendProgress(`Detected: ${ordered.join(', ')}. Resolving…\n`);

      // Parse + resolve every detected ecosystem in parallel. Each section
      // captures its own error so a failure in one does not abort the others.
      const settled = await Promise.all(
        ordered.map(eco =>
          resolveEcosystem(eco, githubRef, { includeTests, onProgress: appendProgress })
            .then(section => ({ ok: true, section }))
            .catch(err   => ({ ok: false, ecosystem: eco, error: err.message }))
        )
      );

      progressDiv.hidden = true;

      const showHeader = ordered.length >= 2;

      // Each section keeps its own sort state in its own closure.
      for (const entry of settled) {
        if (!entry.ok) {
          renderSectionError(resultsDiv, entry.ecosystem, entry.error, showHeader);
          continue;
        }

        const section = entry.section;
        let sortCol = 'releaseDate';
        let sortDir = 'desc';

        function rerender() {
          // Tear down the existing section element if it exists, then redraw.
          const prior = resultsDiv.querySelector(`section[data-ecosystem="${section.ecosystem}"]`);
          if (prior) prior.remove();

          const sortedRows = sortResultsBy(section.results, sortCol, sortDir);
          const sectionEl = renderSection(resultsDiv, {
            ecosystem:   section.ecosystem,
            showHeader,
            sorted:      sortedRows,
            directCount: section.directCount,
            source:      section.source,
            note:        section.note,
            sortCol,
            sortDir,
          });

          sectionEl.querySelectorAll('th[data-col]').forEach(th => {
            const col = th.dataset.col;
            th.addEventListener('click', () => {
              if (sortCol === col) {
                sortDir = sortDir === 'asc' ? 'desc' : 'asc';
              } else {
                sortCol = col;
                sortDir = (col === 'name' || col === 'version') ? 'asc' : 'desc';
              }
              rerender();
            });
          });
        }

        rerender();
      }

      resultsDiv.hidden = false;
    } catch (err) {
      showError(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}
