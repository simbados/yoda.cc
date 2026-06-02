/**
 * Browser entry point for brewview.
 * Wires the HTML form to the Homebrew dependency resolver and renders
 * results into a sortable table. All HTTP calls go directly to the
 * formulae.brew.sh API from the browser — no server-side component.
 */

import { resolve } from './src/homebrew/resolver.js';
import { setGithubToken } from './src/homebrew/client.js';

// ── Pure utility functions (exported for testing) ─────────────────────────────

/**
 * Parses a freeform multi-formula input string into an array of lowercase formula names.
 * Supports three input formats:
 *   1. Comma-separated:      "vim, ffmpeg, wget"
 *   2. Backslash-newline:    "vim \\\n  ffmpeg"
 *   3. brew outdated output: "fzf (0.72.0) < 0.73.0"  → extracts "fzf"
 * Names are lowercased, deduplicated, and empty entries are dropped.
 * @param {string} text - raw user input
 * @returns {string[]} ordered, deduplicated list of formula names
 */
export function parseBrewInput(text) {
  const MAX_NAMES = 50;
  return text
    .replace(/\\[ \t]*\n[ \t]*/g, ',')
    .split(/[,\n]+/)
    .map(part => (part.trim().split(/\s+/)[0] ?? '').toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, MAX_NAMES);
}

/**
 * Returns the number of whole days elapsed between today and an ISO date string.
 * Returns Infinity for null or unparseable dates so those entries never match
 * a recency threshold.
 * @param {string|null|undefined} dateStr
 * @returns {number}
 */
export function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms)) return Infinity;
  return Math.floor(ms / 86_400_000);
}

/**
 * Formats an integer with locale-aware thousand separators (e.g. 1234 → "1,234").
 * Returns "–" when the value is null or undefined.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatInstalls(n) {
  if (n == null) return '–';
  return n.toLocaleString();
}

/**
 * Sorts a Map of resolved packages by a given column.
 * Null numeric values always sink to the bottom regardless of sort direction.
 * String columns use localeCompare; numeric columns compare by value.
 * Name is used as a tiebreaker for deterministic output.
 * @param {Map<string, object>} resultsMap
 * @param {'name'|'version'|'installs365'} column
 * @param {'asc'|'desc'} direction
 * @returns {Array<object>}
 */
export function sortResultsBy(resultsMap, column, direction) {
  const sign   = direction === 'asc' ? 1 : -1;
  const isNum  = column === 'installs365';
  const isDate = column === 'updatedAt';

  return [...resultsMap.values()].sort((a, b) => {
    const aVal = a[column] ?? null;
    const bVal = b[column] ?? null;

    if (isNum) {
      const aNull = aVal == null;
      const bNull = bVal == null;
      if (aNull && bNull) return a.name.localeCompare(b.name);
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = aVal - bVal;
      return cmp !== 0 ? sign * cmp : a.name.localeCompare(b.name);
    }

    if (isDate) {
      const aNull = aVal == null;
      const bNull = bVal == null;
      if (aNull && bNull) return a.name.localeCompare(b.name);
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = aVal.localeCompare(bVal);
      return cmp !== 0 ? sign * cmp : a.name.localeCompare(b.name);
    }

    const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
    return cmp !== 0 ? sign * cmp : 0;
  });
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Appends a <td> with text content to a row and returns the cell.
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
 * Populates the results container with a summary line and a dependency table.
 * Packages are annotated by depth: depth 0 = the root formula itself,
 * depth 1 = direct dependencies, depth 2+ = transitive dependencies.
 * @param {HTMLElement} container
 * @param {Array<object>} sorted - result objects from sortResultsBy()
 */
function renderResults(container, sorted) {
  container.hidden = false;
  container.innerHTML = '';

  const total         = sorted.length;
  const rootCount       = sorted.filter(p => p.depth === 0).length;
  const directCount     = sorted.filter(p => p.depth === 1).length;
  const transitiveCount = sorted.filter(p => p.depth > 1).length;

  const summary = document.createElement('p');
  summary.className = 'summary';
  if (rootCount > 0 && (directCount > 0 || transitiveCount > 0)) {
    const rootLabel = `${rootCount} root${rootCount !== 1 ? 's' : ''}`;
    summary.textContent =
      `${total} package${total !== 1 ? 's' : ''} total ` +
      `(${rootLabel}, ${directCount} direct, ${transitiveCount} transitive)`;
  } else {
    summary.textContent = `${total} package${total !== 1 ? 's' : ''} total`;
  }
  container.appendChild(summary);

  if (total === 0) {
    const msg = document.createElement('p');
    msg.textContent = 'No packages found.';
    container.appendChild(msg);
    return;
  }

  const table = document.createElement('table');

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  const COL_DEFS = [
    ['Package',        'name'],
    ['Type',           'type'],
    ['Version',        'version'],
    ['Updated',        'updatedAt'],
    ['Installs/year',  'installs365'],
  ];
  for (const [label, col] of COL_DEFS) {
    const th = document.createElement('th');
    th.textContent = label;
    th.dataset.col = col;
    headerRow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const pkg of sorted) {
    const tr = tbody.insertRow();

    const nameTd = tr.insertCell();
    const a = document.createElement('a');
    a.href   = pkg.link?.startsWith('https://') ? pkg.link : '#';
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    a.textContent = pkg.name;
    nameTd.appendChild(a);
    if (pkg.caskAlsoExists) {
      const hint = document.createElement('a');
      hint.href      = `https://formulae.brew.sh/cask/${pkg.name}`;
      hint.target    = '_blank';
      hint.rel       = 'noopener noreferrer';
      hint.textContent = 'cask';
      hint.className = 'cask-hint';
      nameTd.appendChild(hint);
    }

    addCell(tr, pkg.type);

    if (pkg.error) {
      tr.className = 'row-error';
      const td = addCell(tr, pkg.error);
      td.colSpan = 3;
      continue;
    }

    addCell(tr, pkg.version);
    const updatedCell = addCell(tr, pkg.updatedAt ?? '–');
    if (daysSince(pkg.updatedAt) <=  7) updatedCell.className = 'age-new';
    else if (daysSince(pkg.updatedAt) <= 30) updatedCell.className = 'age-fresh';
    addCell(tr, formatInstalls(pkg.installs365));
  }

  const tableScroll = document.createElement('div');
  tableScroll.className = 'table-scroll';
  tableScroll.appendChild(table);
  container.appendChild(tableScroll);
}

// ── Browser initialisation ────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
  const form             = document.getElementById('form');
  const formulaInput     = document.getElementById('formula-input');
  const includeBuildCb   = document.getElementById('include-build');
  const tokenInput       = document.getElementById('token-input');
  const rememberTokenCb  = document.getElementById('remember-token');
  const storageNote      = document.getElementById('storage-note');
  const submitBtn        = document.getElementById('submit-btn');
  const errorDiv         = document.getElementById('error');
  const progressDiv      = document.getElementById('progress');
  const resultsDiv       = document.getElementById('results');

  const TOKEN_STORAGE_KEY = 'brewview.github_token';

  function syncStorageNote() {
    storageNote.hidden = !rememberTokenCb.checked;
  }

  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (savedToken) {
    tokenInput.value        = savedToken;
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

  formulaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
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

    errorDiv.hidden      = true;
    errorDiv.textContent = '';
    progressDiv.hidden   = true;
    progressDiv.textContent = '';
    resultsDiv.hidden    = true;
    resultsDiv.innerHTML = '';

    const token            = tokenInput.value.trim();
    const names            = parseBrewInput(formulaInput.value);
    const includeBuildDeps = includeBuildCb.checked;

    if (rememberTokenCb.checked && token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    if (names.length === 0) {
      showError('Enter at least one formula or cask name.');
      return;
    }

    setGithubToken(token || null);
    submitBtn.disabled = true;

    try {
      const { results, rateLimited } = await resolve(names, {
        includeBuildDeps,
        onProgress: msg => appendProgress(msg + '\n'),
      });

      progressDiv.hidden = true;

      // Non-fatal: the dependency tree resolved, but GitHub rate-limited the
      // update-date lookups, so some "Updated" cells will be blank. Surface it
      // in the (amber) banner so the missing dates are explained.
      if (rateLimited) {
        showError(
          'GitHub API rate limit reached — some "Updated" dates could not be fetched. ' +
          'Add a personal access token above to raise the limit to 5 000 req/hr, or wait for the unauthenticated limit (60/hr) to reset.'
        );
      }

      let sortCol = 'updatedAt';
      let sortDir = 'desc';

      function rerender() {
        renderResults(resultsDiv, sortResultsBy(results, sortCol, sortDir));

        resultsDiv.querySelectorAll('th[data-col]').forEach(th => {
          const col = th.dataset.col;
          th.classList.toggle('th-sort-asc',  col === sortCol && sortDir === 'asc');
          th.classList.toggle('th-sort-desc', col === sortCol && sortDir === 'desc');
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
    } catch (err) {
      showError(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}
