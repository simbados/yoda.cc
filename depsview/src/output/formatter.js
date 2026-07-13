/**
 * Output formatters for the resolved dependency list.
 * Supports a human-readable padded column table (default) and grouped JSON (--json).
 *
 * The table applies ANSI color coding to date cells when stdout is a TTY.
 * Both the "Released" and "First Release" columns follow the same scheme:
 *   red    — 3 days ago or less  (very recent)
 *   orange — 7 days ago or less  (recent)
 *   yellow — 30 days ago or less (somewhat recent)
 * Supply chain scores use a separate tri-colour scale: green ≥ 80 %, yellow 50–79 %, red < 50 %.
 *
 * Multi-ecosystem output is rendered as one section per ecosystem in the fixed
 * order npm → python → go. Single-ecosystem projects are still rendered as a
 * single section; an explicit section header is only emitted when at least two
 * ecosystems are present.
 */

import { domainOf, groupByDomain } from './nonStandardSources.js';

const ANSI_RED    = '\x1b[31m';
const ANSI_ORANGE = '\x1b[38;5;208m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_GREEN  = '\x1b[32m';
const ANSI_RESET  = '\x1b[0m';

/** Ecosystems are always rendered in this fixed order. */
const ECOSYSTEM_ORDER = ['npm', 'python', 'go', 'rust'];

/**
 * Maps a depsview ecosystem label to the corresponding socket.dev PURL type.
 * Used only for looking up supply chain scores by the canonical map key
 * (`${purl}:${name.toLowerCase()}@${version}`).
 * @param {'npm'|'python'|'go'|'rust'|'rust'} ecosystem
 * @returns {'npm'|'pypi'|'golang'|'cargo'}
 */
function purlEcosystem(ecosystem) {
  return ecosystem === 'python' ? 'pypi'
       : ecosystem === 'go'     ? 'golang'
       : ecosystem === 'rust'   ? 'cargo'
       : 'npm';
}

/**
 * Returns the number of whole days between a date string and a reference date.
 * Returns Infinity when the date string is missing or "unknown" so that those
 * cells never accidentally match a recency threshold.
 * @param {string} dateStr - ISO date string like "2023-05-22", or "unknown"
 * @param {Date} now - reference point for the age calculation
 * @returns {number} whole days elapsed, or Infinity if the date is unavailable
 */
function daysSince(dateStr, now) {
  if (!dateStr || dateStr === 'unknown') return Infinity;
  const diffMs = now - new Date(dateStr);
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Wraps a string in an ANSI color code + reset sequence, but only when color is
 * non-null and stdout is a TTY. When stdout is piped (e.g. redirected to a file
 * or another process) the raw string is returned so ANSI codes do not pollute the output.
 * The caller must pad the string to the desired column width BEFORE calling this function
 * because padEnd counts escape sequences as printable characters.
 * @param {string} cell - already-padded cell text
 * @param {string|null} color - ANSI escape code, or null for no color
 * @returns {string}
 */
function applyColor(cell, color) {
  if (!color || !process.stdout.isTTY) return cell;
  return `${color}${cell}${ANSI_RESET}`;
}

/**
 * Returns display text and ANSI color code for a supply chain score.
 * Scores are color-coded by severity: green ≥ 80 %, yellow 50–79 %, red < 50 %.
 * Null (score not available) returns a dash with no color.
 * @param {number|null} score - supply chain score in range 0–1, or null when unavailable
 * @returns {{ text: string, color: string|null }}
 */
function socketScoreDisplay(score) {
  if (score == null) return { text: '-', color: null };
  const pct  = Math.round(score * 100);
  const color = score >= 0.8 ? ANSI_GREEN : score >= 0.5 ? ANSI_YELLOW : ANSI_RED;
  return { text: `${pct}%`, color };
}

/**
 * Converts the resolved dependency map into a sorted array of result objects.
 * Primary sort: release date descending (newest first). ISO-8601 date strings
 * ("YYYY-MM-DD") compare correctly as plain strings, so localeCompare suffices.
 * Packages whose release date is "unknown" always sort to the bottom because
 * the letter 'u' would otherwise rank above any digit in a descending compare.
 * Secondary sort (tiebreaker): package name ascending for deterministic output.
 *
 * Supply chain scores from socket.dev are joined by the ecosystem-tagged
 * canonical key `${purlEcosystem}:${name.toLowerCase()}@${version}`. When no
 * ecosystem is provided, lookups are attempted unscoped for backwards-compat
 * with existing tests.
 *
 * @param {Map<string, object>} results - per-ecosystem resolved package map
 * @param {Map<string, number>} [socketScores] - shared scores Map
 * @param {{ ecosystem?: 'npm'|'python'|'go'|'rust' }} [opts]
 * @returns {Array<object>}
 */
function sortedResults(results, socketScores = new Map(), opts = {}) {
  const { ecosystem } = opts;
  const purlEco = ecosystem ? purlEcosystem(ecosystem) : null;

  return [...results.values()]
    .map(r => ({
      name:               r.name,
      version:            r.version,
      released:           r.releaseDate,
      firstReleased:      r.firstReleaseDate ?? 'unknown',
      releases:           r.releaseCount ?? 0,
      downloadsLastMonth: r.downloadsLastMonth ?? null,
      link:               r.link ?? `https://pypi.org/project/${r.name}/`,
      error:              r.error,
      supplyChain:        purlEco
        ? (socketScores.get(`${purlEco}:${r.name.toLowerCase()}@${r.version}`) ?? null)
        : (socketScores.get(`${r.name.toLowerCase()}@${r.version}`) ?? null),
    }))
    .sort((a, b) => {
      const aUnknown = a.released === 'unknown';
      const bUnknown = b.released === 'unknown';
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      const dateCmp = b.released.localeCompare(a.released);
      if (dateCmp !== 0) return dateCmp;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
}

/**
 * Formats a monthly download count for display in the table.
 * Returns the number formatted with thousand separators (e.g. 34,567,890),
 * or "-" when the value is null (stats unavailable for that package).
 * Uses en-US locale explicitly so the separator is always a comma regardless
 * of the system locale where the tool is run.
 * @param {number|null} count
 * @returns {string}
 */
function formatDownloads(count) {
  return count !== null ? count.toLocaleString('en-US') : '-';
}

/**
 * Prints a non-standard sources block after the table.
 * - `dangerousDeps` (⚠) — explicitly declared non-registry specs in manifests.
 * - `privatePkgs`   (ℹ) — packages resolved from non-public registries; grouped by domain.
 * Emits nothing when both arrays are empty.
 * @param {Array<{ name: string, spec: string, reason: string }>} dangerousDeps
 * @param {Array<{ name: string, url: string }>}                  privatePkgs
 */
function printNonStandardSources(dangerousDeps, privatePkgs) {
  if (!dangerousDeps.length && !privatePkgs.length) return;

  console.log('');
  console.log('Non-standard sources:');

  if (dangerousDeps.length) {
    console.log('  ⚠ Non-registry dependency specs (declared in manifest):');
    for (const { name, spec, reason } of dangerousDeps) {
      console.log(`    ${name}  ${spec}  [${reason}]`);
    }
  }

  if (privatePkgs.length) {
    console.log('  ℹ Non-public registry packages (skipped from resolution):');
    for (const [domain, names] of groupByDomain(privatePkgs)) {
      console.log(`    ${domain}: ${names.join(', ')}`);
    }
  }
}

/**
 * Formats one section (one ecosystem) as a padded plain-text table.
 *
 * Column visibility:
 *   - First Release: shown unless `firstRelease: false` (Go modules hide this).
 *   - Downloads/mo:  shown only when `downloadStats: true` (Python only).
 *   - Supply Chain:  shown when `socketScores` is provided (any ecosystem).
 *
 * When `printHeader` is true (multi-ecosystem output), a section heading is
 * emitted above the table.
 *
 * @param {Map<string, object>} results
 * @param {Set<string>} directNames - normalised direct dep names for the footer
 * @param {object} [opts]
 * @param {'npm'|'python'|'go'|'rust'}      [opts.ecosystem]           - used for socket key lookup & defaults
 * @param {boolean}                  [opts.downloadStats=false] - show Downloads/mo column
 * @param {Map<string,number>|null}  [opts.socketScores=null]   - shared supply chain scores
 * @param {string|null}              [opts.source=null]         - dep file name(s) shown in footer
 * @param {string|null}              [opts.note=null]           - per-section warning shown after header
 * @param {boolean}                  [opts.firstRelease=true]   - show First Release column
 * @param {boolean}                  [opts.printHeader=false]   - emit a section heading
 */
function formatTable(results, directNames, opts = {}) {
  const {
    ecosystem      = null,
    downloadStats  = false,
    socketScores   = null,
    source         = null,
    note           = null,
    privateCount   = 0,
    privatePkgs    = [],
    dangerousDeps  = [],
    firstRelease   = true,
    printHeader    = false,
  } = opts;

  if (printHeader && ecosystem) {
    console.log(`=== ${ecosystem} ===`);
  }
  if (note) console.log(`[note] ${note}`);
  if (privateCount > 0) console.log(`[note] ${privateCount} private package${privateCount === 1 ? '' : 's'} skipped (not on public registry).`);

  const rows = sortedResults(results, socketScores ?? new Map(), { ecosystem });
  if (rows.length === 0) {
    console.log('No dependencies found.');
    if (source) console.log(`Files: ${source}`);
    if (printHeader) console.log('');
    return;
  }

  const showSocket = socketScores != null;
  const showFirst  = firstRelease;

  // Compute column widths based on the widest value in each column
  const colName   = Math.max(7,  ...rows.map(r => r.name.length))     + 2;
  const colVer    = Math.max(7,  ...rows.map(r => r.version.length))   + 2;
  const colRel    = Math.max(8,  ...rows.map(r => r.released.length))  + 2;
  const colFirst  = showFirst
    ? Math.max(13, ...rows.map(r => r.firstReleased.length)) + 2
    : 0;
  const colPop    = Math.max(8,  ...rows.map(r => String(r.releases).length)) + 2;
  const colDl     = downloadStats
    ? Math.max(12, ...rows.map(r => formatDownloads(r.downloadsLastMonth).length)) + 2
    : 0;
  const colSocket = showSocket
    ? Math.max(12, ...rows.map(r => socketScoreDisplay(r.supplyChain).text.length)) + 2
    : 0;
  const colLink   = Math.max(4,  ...rows.map(r => r.link.length)) + 2;

  const pad = (s, n) => String(s).padEnd(n);
  const divider = '-'.repeat(colName + colVer + colRel + colFirst + colPop + colDl + colSocket + colLink);

  console.log(
    pad('Package', colName) + pad('Version', colVer) + pad('Released', colRel) +
    (showFirst ? pad('First Release', colFirst) : '') +
    pad('Releases', colPop) +
    (downloadStats ? pad('Downloads/mo', colDl) : '') +
    (showSocket    ? pad('Supply Chain', colSocket) : '') +
    pad('Link', colLink)
  );
  console.log(divider);

  const now = new Date();
  for (const row of rows) {
    const relAge   = daysSince(row.released, now);
    const relColor = relAge <= 3 ? ANSI_RED : relAge <= 7 ? ANSI_ORANGE : relAge <= 30 ? ANSI_YELLOW : null;
    const releasedCell = applyColor(pad(row.released, colRel), relColor);

    let firstRelCell = '';
    if (showFirst) {
      const firstAge   = daysSince(row.firstReleased, now);
      const firstColor = firstAge <= 3 ? ANSI_RED : firstAge <= 7 ? ANSI_ORANGE : firstAge <= 30 ? ANSI_YELLOW : null;
      firstRelCell = applyColor(pad(row.firstReleased, colFirst), firstColor);
    }

    let socketCell = '';
    if (showSocket) {
      const { text, color } = socketScoreDisplay(row.supplyChain);
      socketCell = applyColor(pad(text, colSocket), color);
    }

    let line = pad(row.name, colName)
      + pad(row.version, colVer)
      + releasedCell
      + firstRelCell
      + pad(row.releases, colPop)
      + (downloadStats ? pad(formatDownloads(row.downloadsLastMonth), colDl) : '')
      + socketCell
      + pad(row.link, colLink);
    if (row.error) line += `  [${row.error}]`;
    console.log(line);
  }

  console.log(divider);
  if (directNames.size > 0) {
    const directCount     = rows.filter(r => directNames.has(r.name.toLowerCase().replace(/[-_.]+/g, '-'))).length;
    const transitiveCount = rows.length - directCount;
    console.log(`${rows.length} packages total  (${directCount} direct, ${transitiveCount} transitive)`);
  } else {
    console.log(`${rows.length} packages total`);
  }
  if (source) console.log(`Files: ${source}`);
  printNonStandardSources(dangerousDeps, privatePkgs);
  if (printHeader) console.log('');
}

/**
 * Renders a multi-ecosystem text report. Sections are emitted in the fixed
 * order npm → python → go, with a per-section heading when at least two
 * ecosystems are present. Empty/missing ecosystems are skipped.
 *
 * @param {Map<'npm'|'python'|'go'|'rust', { source, results, directNames, note? }>} sections
 * @param {object} [opts]
 * @param {boolean}                 [opts.downloadStats=false]
 * @param {Map<string,number>|null} [opts.socketScores=null]
 */
function formatMulti(sections, opts = {}) {
  const { downloadStats = false, socketScores = null } = opts;
  const present = ECOSYSTEM_ORDER.filter(eco => sections.has(eco));
  const printHeader = present.length >= 2;

  for (const ecosystem of present) {
    const { results, directNames, source, note, privateCount = 0, privatePkgs = [], dangerousDeps = [] } = sections.get(ecosystem);
    formatTable(results, directNames, {
      ecosystem,
      // Per-ecosystem column rules:
      downloadStats: downloadStats && ecosystem === 'python',
      socketScores,
      source,
      note,
      privateCount,
      privatePkgs,
      dangerousDeps,
      firstRelease: ecosystem !== 'go',
      printHeader,
    });
  }
}

/**
 * Emits the resolved dependencies as a grouped JSON object keyed by ecosystem.
 * Single-ecosystem invocations still produce a one-key object so downstream
 * consumers always know the shape.
 *
 * Each row contains name, version, released, releases, link and (per-ecosystem):
 *   - firstReleased        — npm/python only
 *   - downloadsLastMonth   — python only, when `downloadStats: true`
 *   - supplyChainScore     — any ecosystem, when `socketScores` is provided
 *   - error                — when resolution failed for that package
 *
 * @param {Map<'npm'|'python'|'go'|'rust', { results }>} sections
 * @param {object} [opts]
 * @param {boolean}                 [opts.downloadStats=false]
 * @param {Map<string,number>|null} [opts.socketScores=null]
 */
function formatJson(sections, opts = {}) {
  const { downloadStats = false, socketScores = null } = opts;
  const out = {};

  for (const ecosystem of ECOSYSTEM_ORDER) {
    if (!sections.has(ecosystem)) continue;
    const { results } = sections.get(ecosystem);
    const includeFirst    = ecosystem !== 'go';
    const includeDownloads = downloadStats && ecosystem === 'python';

    out[ecosystem] = sortedResults(results, socketScores ?? new Map(), { ecosystem }).map(r => {
      const obj = { name: r.name, version: r.version, released: r.released, releases: r.releases, link: r.link };
      if (includeFirst)        obj.firstReleased       = r.firstReleased;
      if (includeDownloads)    obj.downloadsLastMonth  = r.downloadsLastMonth;
      if (socketScores != null) obj.supplyChainScore   = r.supplyChain;
      if (r.error)             obj.error               = r.error;
      return obj;
    });
  }

  console.log(JSON.stringify(out, null, 2));
}

export {
  formatTable,
  formatMulti,
  formatJson,
  sortedResults,
  daysSince,
  purlEcosystem,
  ECOSYSTEM_ORDER,
  ANSI_RED, ANSI_ORANGE, ANSI_YELLOW, ANSI_GREEN, ANSI_RESET,
};
