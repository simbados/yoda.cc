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

import { parseGithubUrl } from "./src/github/url.js";
import {
  parseGithubDependencies,
  parseGithubNpmDependencies,
  parseGithubGoDependencies,
  parseGithubRustDependencies,
} from "./src/github/parser.js";
import { resolveDependencies } from "./src/python/depResolver.js";
import { resolveDependencies as resolveNpm } from "./src/npm/depResolver.js";
import { resolveDependencies as resolveGo } from "./src/go/depResolver.js";
import { resolveDependencies as resolveRust } from "./src/rust/depResolver.js";
import { setGithubToken } from "./src/github/client.js";
import { listDirectory } from "./src/github/client.js";
import { parseMultiPackageInput } from "./src/multiPackageParser.js";
import { parsePastedDependencies } from "./src/pastedDepsParser.js";
import { fetchSocketScores, scoreKey } from "./src/socket/client.js";
import { groupByDomain } from "./src/output/nonStandardSources.js";
import { NPM_LOCK_FILENAMES } from "./src/npm/lockRegistry.js";

/** Fixed rendering order for ecosystem sections. */
export const ECOSYSTEM_ORDER = ["npm", "python", "go", "rust"];

/**
 * Base URL of the Cloudflare Worker CORS proxy for socket.dev.
 * Set this to your deployed Worker URL (without a trailing slash).
 * Leave empty to disable Supply Chain scores in the browser.
 */
const SOCKET_PROXY_BASE = "https://socket-proxy.yoda.cc";

/**
 * Base URL of the Cloudflare Worker CORS proxy for pypistats.org.
 * pypistats.org does not emit CORS headers, so the browser cannot call it directly.
 * The Worker adds CORS headers and forwards the response unchanged.
 */
const PYPISTATS_PROXY_BASE = "https://socket-proxy.yoda.cc/pypistats/packages";

/**
 * Maps the internal ecosystem identifier to the PURL type expected by socket.dev.
 * Go modules use 'golang', Python packages use 'pypi', Rust crates use 'cargo'.
 */
const ECOSYSTEM_PURL_TYPE = { npm: "npm", python: "pypi", go: "golang", rust: "cargo" };

/** Maps ecosystem to the socket.dev URL slug used in package detail links. */
const SOCKET_URL_SLUG = { npm: "npm", python: "pypi", go: "go", rust: "cargo" };

// ── Pure utility functions (exported for testing) ─────────────────────────────

/**
 * Formats an integer with locale-aware thousand separators (e.g. 1234 → "1,234").
 * Returns "–" when the value is null or undefined.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n == null) return "–";
  return n.toLocaleString();
}

/**
 * Formats a supply chain score (0–1) as a whole-number percentage string.
 * Returns "–" when the value is null or undefined.
 * @param {number|null|undefined} n - score in the range 0–1
 * @returns {string} e.g. "87%" or "–"
 */
export function formatScore(n) {
  if (n == null) return "–";
  return `${Math.round(n * 100)}%`;
}

/**
 * Returns the number of whole days elapsed between today and an ISO date string.
 * Returns Infinity for "unknown" or unparseable dates so those entries sort last.
 * @param {string|null|undefined} dateStr
 * @returns {number}
 */
export function daysSince(dateStr) {
  if (!dateStr || dateStr === "unknown") return Infinity;
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
  const sign = direction === "asc" ? 1 : -1;
  const isDate = column === "releaseDate" || column === "firstReleaseDate";
  const isNum =
    column === "releaseCount" || column === "downloadsLastMonth" || column === "supplyChain";

  return [...resultsMap.values()].sort((a, b) => {
    const aVal = a[column] ?? (isDate ? "unknown" : null);
    const bVal = b[column] ?? (isDate ? "unknown" : null);

    if (isDate) {
      const aUnk = aVal === "unknown";
      const bUnk = bVal === "unknown";
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

    const cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
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
  return sortResultsBy(resultsMap, "releaseDate", "desc");
}

/**
 * Returns the set of ecosystems whose dependency files appear in a directory listing.
 * @param {Array<{ name: string, type: string }>} listing
 * @returns {Set<'npm'|'python'|'go'|'rust'>}
 */
export function detectEcosystems(listing) {
  const names = new Set(listing.map((e) => e.name));
  const found = new Set();
  if ([...NPM_LOCK_FILENAMES].some((f) => names.has(f)) || names.has("package.json"))
    found.add("npm");
  if (names.has("go.sum") || names.has("go.mod")) found.add("go");
  if (names.has("Cargo.lock") || names.has("Cargo.toml")) found.add("rust");
  if (
    names.has("pyproject.toml") ||
    names.has("requirements.txt") ||
    names.has("requirements_all.txt") ||
    names.has("setup.cfg") ||
    names.has("Pipfile") ||
    names.has("manifest.json")
  )
    found.add("python");
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
  if (set.has("npm")) return "npm";
  if (set.has("go")) return "go";
  if (set.has("rust")) return "rust";
  if (set.has("python")) return "python";
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
 * @param {'npm'|'python'|'go'|'rust'} cfg.ecosystem
 * @param {boolean}     cfg.showHeader        - emit a section title above the table
 * @param {Array<object>} cfg.sorted          - already-sorted rows from sortResultsBy
 * @param {number}      cfg.directCount       - 0 when unknown (lock-file resolution)
 * @param {string|null} cfg.source            - dependency file name
 * @param {string|null} cfg.note              - informational note (e.g. pnpm-lock v9)
 * @param {string|null} cfg.sortCol           - current sort column for sort indicators
 * @param {string|null} cfg.sortDir           - 'asc' or 'desc'
 * @param {boolean}     [cfg.showSupplyChain]  - when true, render a Supply Chain % column
 * @param {string|null} [cfg.socketSlug]       - socket.dev URL slug ('npm'|'pypi'|'go'); adds (link) anchors in score cells
 * @param {boolean}     [cfg.showDownloads]    - when true, render a downloads column (label depends on ecosystem)
 * @returns {HTMLElement} the section element
 */
function renderSection(container, cfg) {
  const sectionEl = document.createElement("section");
  sectionEl.className = "result-section";
  sectionEl.dataset.ecosystem = cfg.ecosystem;

  if (cfg.showHeader) {
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = cfg.ecosystem;
    sectionEl.appendChild(h2);
  }

  const total = cfg.sorted.length;
  const summary = document.createElement("p");
  summary.className = "summary";
  if (cfg.directCount > 0) {
    const transitiveCount = total - cfg.directCount;
    summary.textContent = `${total} package${total !== 1 ? "s" : ""} total (${cfg.directCount} direct, ${transitiveCount} transitive)`;
  } else {
    summary.textContent = `${total} package${total !== 1 ? "s" : ""} total`;
  }
  sectionEl.appendChild(summary);

  if (cfg.source) {
    const sourceEl = document.createElement("p");
    sourceEl.className = "source-files";
    sourceEl.textContent = `Files: ${cfg.source}`;
    sectionEl.appendChild(sourceEl);
  }

  for (const noteText of [
    cfg.note,
    cfg.privateCount > 0
      ? `${cfg.privateCount} private package${cfg.privateCount === 1 ? "" : "s"} skipped (not on public registry).`
      : null,
  ].filter(Boolean)) {
    const noteEl = document.createElement("p");
    noteEl.className = "note note-warning";
    noteEl.textContent = `ⓘ ${noteText}`;
    sectionEl.appendChild(noteEl);
  }

  if (total === 0) {
    const msg = document.createElement("p");
    msg.textContent = "No dependencies found.";
    sectionEl.appendChild(msg);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  const showFirst = cfg.ecosystem !== "go";

  const table = document.createElement("table");
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  const COL_DEFS = [
    ["Package", "name"],
    ["Version", "version"],
    ["Released", "releaseDate"],
  ];
  if (showFirst) COL_DEFS.push(["First Release", "firstReleaseDate"]);
  COL_DEFS.push(["Releases", "releaseCount"]);
  if (cfg.showDownloads)
    COL_DEFS.push([
      cfg.ecosystem === "rust" ? "Downloads (90d)" : "Downloads/mo",
      "downloadsLastMonth",
    ]);
  if (cfg.showSupplyChain) COL_DEFS.push(["Supply Chain", "supplyChain"]);

  for (const [label, col] of COL_DEFS) {
    const th = document.createElement("th");
    th.textContent = label;
    th.dataset.col = col;
    if (col === cfg.sortCol) th.classList.add(`th-sort-${cfg.sortDir}`);
    headerRow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const pkg of cfg.sorted) {
    const tr = tbody.insertRow();

    const nameTd = tr.insertCell();
    const a = document.createElement("a");
    const rawLink = pkg.link ?? `https://pypi.org/project/${pkg.name}/`;
    a.href = rawLink.startsWith("https://") ? rawLink : `https://pypi.org/project/${pkg.name}/`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = pkg.name;
    nameTd.appendChild(a);

    if (pkg.error) {
      tr.className = "row-error";
      const td = addCell(tr, pkg.version ?? "error");
      td.colSpan = COL_DEFS.length - 1;
      td.title = pkg.error;
      continue;
    }

    addCell(tr, pkg.version);

    const relCell = addCell(tr, pkg.releaseDate ?? "unknown");
    const relAge = daysSince(pkg.releaseDate);
    if (relAge <= 3) relCell.className = "age-new";
    else if (relAge <= 7) relCell.className = "age-orange";
    else if (relAge <= 30) relCell.className = "age-fresh";

    if (showFirst) {
      const firstCell = addCell(tr, pkg.firstReleaseDate ?? "unknown");
      const firstAge = daysSince(pkg.firstReleaseDate);
      if (firstAge <= 3) firstCell.className = "age-new";
      else if (firstAge <= 7) firstCell.className = "age-orange";
      else if (firstAge <= 30) firstCell.className = "age-fresh";
    }

    addCell(tr, formatNumber(pkg.releaseCount ?? 0));
    if (cfg.showDownloads) addCell(tr, formatNumber(pkg.downloadsLastMonth));
    if (cfg.showSupplyChain) {
      const scoreCell = document.createElement("td");
      scoreCell.textContent = formatScore(pkg.supplyChain);
      if (pkg.supplyChain != null) {
        scoreCell.className =
          pkg.supplyChain >= 0.8
            ? "score-good"
            : pkg.supplyChain >= 0.5
              ? "score-warn"
              : "score-bad";
        if (cfg.socketSlug) {
          const encoded = encodeURIComponent(pkg.name).replace(/%40/g, "@").replace(/%2F/gi, "/");
          const socketLink = document.createElement("a");
          socketLink.href = `https://socket.dev/${cfg.socketSlug}/package/${encoded}`;
          socketLink.target = "_blank";
          socketLink.rel = "noopener noreferrer";
          socketLink.textContent = " (link)";
          scoreCell.appendChild(socketLink);
        }
      }
      tr.appendChild(scoreCell);
    }
  }

  const tableWrapper = document.createElement("div");
  tableWrapper.className = "table-scroll";
  tableWrapper.appendChild(table);
  sectionEl.appendChild(tableWrapper);
  container.appendChild(sectionEl);
  return sectionEl;
}

/**
 * Appends a collapsible non-standard sources `<details>` block to `sectionEl`.
 * Uses `groupByDomain` from the shared nonStandardSources module for data processing.
 * All dynamic text is set via `textContent` (never innerHTML) — no XSS risk.
 * Does nothing when both arrays are empty.
 * @param {HTMLElement} sectionEl
 * @param {Array<{ name: string, spec: string, reason: string }>} dangerousDeps
 * @param {Array<{ name: string, url: string }>}                  privatePkgs
 */
function appendNonStandardSources(sectionEl, dangerousDeps, privatePkgs) {
  if (!dangerousDeps.length && !privatePkgs.length) return;

  const total = dangerousDeps.length + privatePkgs.length;
  const details = document.createElement("details");
  details.className = "nonstd";

  const summary = document.createElement("summary");
  summary.textContent = `${total} non-standard source${total !== 1 ? "s" : ""}`;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "nonstd-body";

  const addRow = (className, text) => {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    body.appendChild(p);
  };

  if (dangerousDeps.length) {
    addRow("nonstd-warn", "⚠ Non-registry dependency specs (declared in manifest):");
    for (const { name, spec, reason } of dangerousDeps) {
      addRow("nonstd-warn nonstd-indent", `${name} — ${spec}  (${reason})`);
    }
  }

  if (privatePkgs.length) {
    addRow("nonstd-info", "ℹ Non-public registry packages (skipped from resolution):");
    for (const [domain, names] of groupByDomain(privatePkgs)) {
      addRow("nonstd-info nonstd-indent", `${domain}: ${names.join(", ")}`);
    }
  }

  details.appendChild(body);
  sectionEl.appendChild(details);
}

/**
 * Renders one section into an error banner. Used when a single ecosystem's
 * parse / resolve threw — the other sections still render normally.
 * @param {HTMLElement} container
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @param {string} message
 * @param {boolean} showHeader
 */
function renderSectionError(container, ecosystem, message, showHeader) {
  const sectionEl = document.createElement("section");
  sectionEl.className = "result-section";
  if (showHeader) {
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = ecosystem;
    sectionEl.appendChild(h2);
  }
  const errorEl = document.createElement("p");
  errorEl.className = "note note-warning";
  errorEl.textContent = `ⓘ [${ecosystem}] ${message}`;
  sectionEl.appendChild(errorEl);
  container.appendChild(sectionEl);
}

/**
 * Shows a modal dialog with a ⚠ warning and waits for the user to confirm or cancel.
 * Returns true when the user clicks "Continue", false on cancel or backdrop-dismiss.
 *
 * Uses the native <dialog> element. The dialog is created lazily, appended to the
 * document body, and removed after the user responds. All content is set via
 * textContent — never innerHTML — to keep registry-sourced strings XSS-safe.
 *
 * @param {string} warning - the warning text
 * @returns {Promise<boolean>}
 */
function showWarningDialog(warning) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "warning-dialog";

    const h = document.createElement("h2");
    h.textContent = "⚠ Warning";

    const p = document.createElement("p");
    p.textContent = warning;

    const actions = document.createElement("div");
    actions.className = "warning-dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "btn-secondary";

    const continueBtn = document.createElement("button");
    continueBtn.type = "button";
    continueBtn.textContent = "Continue anyway";
    continueBtn.className = "btn-warning";

    let answered = false;
    function finish(value) {
      if (answered) return;
      answered = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    }

    cancelBtn.addEventListener("click", () => finish(false));
    continueBtn.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", () => finish(false));

    actions.append(cancelBtn, continueBtn);
    dialog.append(h, p, actions);
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

// ── Per-ecosystem parse + resolve (browser side) ──────────────────────────────

/**
 * Runs the parse → resolve pipeline for one ecosystem.
 * Supports three modes:
 *   - GitHub mode (default): parses dependency files from a GitHub ref.
 *   - Package mode (opts.packageInputs set): skips GitHub I/O and resolves one
 *     or more packages by name using entries from parseMultiPackageInput.
 *   - Pasted-text mode (opts.pastedSection set): skips GitHub I/O and uses a
 *     precomputed { deps, source, note, warning, privateCount, privatePkgs,
 *     dangerousDeps } produced by parsePastedDependencies.
 *
 * Returns the section's data needed to render it: deps, resolved results,
 * direct dep names, source filename, and any note.
 *
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @param {object|null} githubRef
 * @param {{ includeTests: boolean, onProgress: (msg: string) => void, packageInputs?: Array<{ name: string, version: string|null }>, pastedSection?: object, downloadStats?: boolean }} opts
 * @returns {Promise<object>}
 */
async function resolveEcosystem(ecosystem, githubRef, opts) {
  const { includeTests, onProgress, packageInputs, pastedSection, downloadStats = false } = opts;

  let deps,
    source,
    note = null,
    warning = null,
    privateCount = 0,
    privatePkgs = [],
    dangerousDeps = [];
  if (pastedSection) {
    ({ deps, source, note, warning, privateCount, privatePkgs, dangerousDeps } = pastedSection);
    if (warning) {
      const confirmed = await showWarningDialog(warning);
      if (!confirmed) return null;
    }
    if (privateCount > 0)
      onProgress(
        `[${ecosystem}] Skipped ${privateCount} private package${privateCount === 1 ? "" : "s"} (not on public registry).\n`,
      );
  } else if (packageInputs && packageInputs.length > 0) {
    source = "package search";
    deps = packageInputs.map((p) =>
      ecosystem === "go"
        ? { name: p.name, version: p.version }
        : { name: p.name, versionSpec: p.version },
    );
  } else if (ecosystem === "npm") {
    ({ deps, source, note, warning, privateCount, privatePkgs, dangerousDeps } =
      await parseGithubNpmDependencies(githubRef, { includeTests }));
    if (warning) {
      const confirmed = await showWarningDialog(warning);
      if (!confirmed) return null;
    }
    if (privateCount > 0)
      onProgress(
        `[npm] Skipped ${privateCount} private package${privateCount === 1 ? "" : "s"} (not on public registry).\n`,
      );
  } else if (ecosystem === "go") {
    ({ deps, source, privateCount, privatePkgs, dangerousDeps } =
      await parseGithubGoDependencies(githubRef));
    if (privateCount > 0)
      onProgress(
        `[go] Skipped ${privateCount} private module${privateCount === 1 ? "" : "s"} (not on public module proxy).\n`,
      );
  } else if (ecosystem === "rust") {
    ({ deps, source, privateCount, privatePkgs, dangerousDeps } =
      await parseGithubRustDependencies(githubRef));
    if (privateCount > 0)
      onProgress(
        `[rust] Skipped ${privateCount} private crate${privateCount === 1 ? "" : "s"} (not on crates.io).\n`,
      );
  } else {
    ({ deps, source, dangerousDeps } = await parseGithubDependencies(githubRef, { includeTests }));
  }

  const isLockFile =
    NPM_LOCK_FILENAMES.has(source) || source === "go.sum" || source === "Cargo.lock";
  onProgress(
    `[${ecosystem}] Found ${deps.length} ${isLockFile ? "installed" : "direct"} dep${deps.length === 1 ? "" : "s"} in ${source}. Resolving…\n`,
  );

  let results;
  if (ecosystem === "npm") {
    results = await resolveNpm(deps, { onProgress: (msg) => onProgress(`[npm] ${msg}\n`) });
  } else if (ecosystem === "go") {
    results = await resolveGo(deps, { onProgress: (msg) => onProgress(`[go] ${msg}\n`) });
  } else if (ecosystem === "rust") {
    results = await resolveRust(deps, { onProgress: (msg) => onProgress(`[rust] ${msg}\n`) });
  } else {
    results = await resolveDependencies(deps, {
      onProgress: (msg) => onProgress(`[python] ${msg}\n`),
      downloadStats,
      pypiStatsBaseUrl: downloadStats ? PYPISTATS_PROXY_BASE : undefined,
    });
  }

  // Direct-count computation (post-resolution so the names line up):
  // - Lock files: npm = unknown (need package.json), go.sum = unknown (need go.mod)
  // - package.json / go.mod / requirements.txt etc.: every parsed dep is direct,
  //   except go.mod where `// indirect` deps are explicitly flagged.
  let directCount = 0;
  if (ecosystem === "npm") {
    if (!isLockFile) {
      const directNames = new Set(deps.map((d) => d.name.toLowerCase()));
      directCount = [...results.values()].filter((r) =>
        directNames.has(r.name.toLowerCase()),
      ).length;
    }
  } else if (ecosystem === "go") {
    if (source === "go.mod") {
      const directNames = new Set(deps.filter((d) => !d.indirect).map((d) => d.name.toLowerCase()));
      directCount = [...results.values()].filter((r) =>
        directNames.has(r.name.toLowerCase()),
      ).length;
    } else if (source === "package search") {
      const directNames = new Set(deps.map((d) => d.name.toLowerCase()));
      directCount = [...results.values()].filter((r) =>
        directNames.has(r.name.toLowerCase()),
      ).length;
    }
  } else if (ecosystem === "rust") {
    // Cargo.lock enumerates the full closure without marking direct crates, so
    // the split is only known from Cargo.toml or package-search input.
    if (source === "Cargo.toml" || source === "package search") {
      const directNames = new Set(deps.map((d) => d.name.toLowerCase()));
      directCount = [...results.values()].filter((r) =>
        directNames.has(r.name.toLowerCase()),
      ).length;
    }
  } else {
    const directNames = new Set(deps.map((d) => d.name.toLowerCase()));
    directCount = [...results.values()].filter((r) => directNames.has(r.name.toLowerCase())).length;
  }

  return {
    ecosystem,
    deps,
    results,
    directCount,
    source,
    note,
    privateCount,
    privatePkgs,
    dangerousDeps,
    downloadStats,
  };
}

// ── Browser initialisation ────────────────────────────────────────────────────

if (typeof document !== "undefined") {
  const form = document.getElementById("form");
  const urlInput = document.getElementById("url-input");
  const urlRow = document.getElementById("url-row");
  const pkgInput = document.getElementById("pkg-input");
  const pkgRow = document.getElementById("pkg-row");
  const pkgSubmitBtn = document.getElementById("pkg-submit-btn");
  const pasteInput = document.getElementById("paste-input");
  const pasteRow = document.getElementById("paste-row");
  const pasteSubmitBtn = document.getElementById("paste-submit-btn");
  const ecoAllOption = document.getElementById("eco-all-option");
  const tokenInput = document.getElementById("token-input");
  const rememberTokenCb = document.getElementById("remember-token");
  const storageNote = document.getElementById("storage-note");
  const socketKeyInput = document.getElementById("socket-key-input");
  const socketOrgInput = document.getElementById("socket-org-input");
  const socketConsentCb = document.getElementById("socket-proxy-consent");
  const rememberSocketCb = document.getElementById("remember-socket");
  const socketStorageNote = document.getElementById("socket-storage-note");
  const includeTestsCb = document.getElementById("include-tests");
  const downloadStatsCb = document.getElementById("download-stats");
  const downloadStatsRow = document.getElementById("download-stats-row");
  const submitBtn = document.getElementById("submit-btn");
  const errorDiv = document.getElementById("error");
  const progressDiv = document.getElementById("progress");
  const resultsDiv = document.getElementById("results");

  const TOKEN_STORAGE_KEY = "depsview.github_token";
  const SOCKET_KEY_STORAGE_KEY = "depsview.socket_key";
  const SOCKET_ORG_STORAGE_KEY = "depsview.socket_org";

  /** Textarea placeholder text per ecosystem. */
  const PKG_PLACEHOLDERS = {
    npm: "eslint, eslint@9, @babel/core  or  https://github.com/owner/repo",
    python: "requests, flask>=2.0, django==4.2  or  https://github.com/owner/repo",
    go: "github.com/gin-gonic/gin, github.com/go-chi/chi  or  https://github.com/owner/repo",
    rust: "serde, tokio@1, clap@^4.5  or  https://github.com/owner/repo",
  };

  /**
   * Shows the row matching the current input source + ecosystem combination:
   *   - 'github' + 'all' ecosystem  → the dedicated GitHub URL row (url-row).
   *   - 'github' or 'packages' + a specific ecosystem → the shared textarea
   *     (pkg-row), which accepts either a GitHub URL or package name(s) —
   *     unchanged from the original single-picker behaviour.
   *   - 'paste' → the paste textarea (paste-row); the ecosystem picker's
   *     'All' option is unavailable in this mode (one paste is one file, so
   *     the ecosystem must be picked to know which formats to check against).
   * The "Show Python download statistics" checkbox row stays visible for the
   * 'all' selection (Python may still be auto-detected) and for the explicit
   * 'python' selection, and is hidden for npm, Go, and Rust. The checkbox is
   * Python-specific because it toggles the opt-in pypistats fetch; Rust shows a
   * downloads column too, but it comes free with the crate record so it needs
   * no toggle.
   */
  function applyRowVisibility() {
    const mode = form.elements["input-source"].value;
    const eco = form.elements["ecosystem"].value;

    urlRow.hidden = !(mode === "github" && eco === "all");
    pkgRow.hidden = !(mode !== "paste" && eco !== "all");
    pasteRow.hidden = mode !== "paste";

    if (eco !== "all") pkgInput.placeholder = PKG_PLACEHOLDERS[eco] ?? "";
    downloadStatsRow.hidden = eco !== "all" && eco !== "python";
  }

  /**
   * Applies input-source changes ('github' / 'packages' / 'paste'). Package
   * search and paste modes always require one specific ecosystem (there is no
   * meaningful 'All' for a single package list or a single pasted file), so
   * the 'All' radio is hidden in those modes and the selection is bumped to
   * 'npm' if it was previously 'all'.
   * @param {string} mode - selected input-source value
   */
  function applyInputSource(mode) {
    ecoAllOption.hidden = mode !== "github";
    const ecoRadios = form.elements["ecosystem"];
    if (mode !== "github" && ecoRadios.value === "all") {
      ecoRadios.value = "npm";
    }
    applyRowVisibility();
  }

  document.querySelectorAll('[name="ecosystem"]').forEach((radio) => {
    radio.addEventListener("change", () => applyRowVisibility());
  });
  document.querySelectorAll('[name="input-source"]').forEach((radio) => {
    radio.addEventListener("change", () => applyInputSource(radio.value));
  });

  // Apply the initial state (page load with 'github' input source + 'all' ecosystem pre-selected).
  applyInputSource(form.elements["input-source"].value);

  /** Enables or disables all three submit buttons together. */
  function setSubmitting(disabled) {
    submitBtn.disabled = disabled;
    pkgSubmitBtn.disabled = disabled;
    pasteSubmitBtn.disabled = disabled;
  }

  function syncStorageNote() {
    storageNote.hidden = !rememberTokenCb.checked;
  }

  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (savedToken) {
    tokenInput.value = savedToken;
    rememberTokenCb.checked = true;
    syncStorageNote();
  }

  rememberTokenCb.addEventListener("change", () => {
    syncStorageNote();
    if (rememberTokenCb.checked) {
      const token = tokenInput.value.trim();
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  });

  function syncSocketStorageNote() {
    socketStorageNote.hidden = !rememberSocketCb.checked;
  }

  const savedSocketKey = localStorage.getItem(SOCKET_KEY_STORAGE_KEY);
  const savedSocketOrg = localStorage.getItem(SOCKET_ORG_STORAGE_KEY);
  if (savedSocketKey || savedSocketOrg) {
    if (savedSocketKey) socketKeyInput.value = savedSocketKey;
    if (savedSocketOrg) socketOrgInput.value = savedSocketOrg;
    rememberSocketCb.checked = true;
    syncSocketStorageNote();
  }

  rememberSocketCb.addEventListener("change", () => {
    syncSocketStorageNote();
    if (rememberSocketCb.checked) {
      const key = socketKeyInput.value.trim();
      const org = socketOrgInput.value.trim();
      if (key) localStorage.setItem(SOCKET_KEY_STORAGE_KEY, key);
      if (org) localStorage.setItem(SOCKET_ORG_STORAGE_KEY, org);
    } else {
      localStorage.removeItem(SOCKET_KEY_STORAGE_KEY);
      localStorage.removeItem(SOCKET_ORG_STORAGE_KEY);
    }
  });

  socketConsentCb.addEventListener("change", () => {
    if (socketConsentCb.checked) {
      socketConsentCb.closest(".option-row").classList.remove("consent-required");
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    errorDiv.hidden = true;
    errorDiv.textContent = "";
    progressDiv.hidden = true;
    progressDiv.textContent = "";
    resultsDiv.hidden = true;
    resultsDiv.innerHTML = "";

    const token = tokenInput.value.trim();
    const includeTests = includeTestsCb.checked;
    const downloadStats = downloadStatsCb.checked;
    const ecosystemFilter = form.elements["ecosystem"].value;
    const inputSource = form.elements["input-source"].value;

    if (rememberTokenCb.checked && token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    const socketKey = socketKeyInput.value.trim();
    const socketOrg = socketOrgInput.value.trim();
    if (rememberSocketCb.checked) {
      if (socketKey) localStorage.setItem(SOCKET_KEY_STORAGE_KEY, socketKey);
      if (socketOrg) localStorage.setItem(SOCKET_ORG_STORAGE_KEY, socketOrg);
    } else {
      localStorage.removeItem(SOCKET_KEY_STORAGE_KEY);
      localStorage.removeItem(SOCKET_ORG_STORAGE_KEY);
    }

    if (socketKey && socketOrg && !socketConsentCb.checked) {
      const row = socketConsentCb.closest(".option-row");
      row.classList.add("consent-required");
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    setGithubToken(token || null);
    setSubmitting(true);

    try {
      let ecosystems;
      let githubRef = null;
      let packageInputs = null;
      let pastedSection = null;

      if (inputSource === "paste") {
        // Pasted-text mode: detect the format within the selected ecosystem
        // and parse it directly — no GitHub/network I/O for the file itself.
        const rawText = pasteInput.value.trim();
        if (!rawText) {
          showError("Paste some dependency-file content.");
          setSubmitting(false);
          return;
        }

        let parsed;
        try {
          parsed = await parsePastedDependencies(rawText, ecosystemFilter, { includeTests });
        } catch (err) {
          showError(err.message);
          setSubmitting(false);
          return;
        }
        ecosystems = new Set([ecosystemFilter]);
        pastedSection = parsed;
        appendProgress(`Pasted content detected as ${parsed.source}. Resolving…\n`);
      } else if (ecosystemFilter === "all") {
        // GitHub repo mode: analyse all ecosystems detected in the repository.
        const url = urlInput.value.trim();
        if (!url) {
          showError("Enter a GitHub repository URL.");
          setSubmitting(false);
          return;
        }

        try {
          githubRef = parseGithubUrl(url);
        } catch (err) {
          showError(err.message);
          setSubmitting(false);
          return;
        }

        appendProgress("Detecting ecosystems…\n");
        const listing = await listDirectory(
          githubRef.owner,
          githubRef.repo,
          githubRef.subpath,
          githubRef.ref,
        );
        ecosystems = detectEcosystems(listing ?? []);
        // Fall back to 'python' so the depth-2 traversal still gets a chance
        // (covers HA-style nested manifest.json layouts).
        if (ecosystems.size === 0) ecosystems = new Set(["python"]);
        const detectedOrdered = ECOSYSTEM_ORDER.filter((eco) => ecosystems.has(eco));
        appendProgress(`Detected: ${detectedOrdered.join(", ")}. Resolving…\n`);
      } else {
        const rawText = pkgInput.value.trim();
        if (!rawText) {
          showError("Enter at least one package name or a GitHub URL.");
          setSubmitting(false);
          return;
        }

        if (/^https?:\/\//i.test(rawText)) {
          // GitHub repo mode with a specific ecosystem filter.
          try {
            githubRef = parseGithubUrl(rawText);
          } catch (err) {
            showError(err.message);
            setSubmitting(false);
            return;
          }
          ecosystems = new Set([ecosystemFilter]);
          appendProgress(`Using: ${ecosystemFilter}. Resolving…\n`);
        } else {
          // Package search mode: one or more package names.
          packageInputs = parseMultiPackageInput(rawText, ecosystemFilter);
          if (packageInputs.length === 0) {
            showError("Enter at least one package name.");
            setSubmitting(false);
            return;
          }
          ecosystems = new Set([ecosystemFilter]);
          const names = packageInputs.map((p) => p.name).join(", ");
          appendProgress(
            `Resolving ${packageInputs.length} ${ecosystemFilter} package${packageInputs.length === 1 ? "" : "s"}: ${names}…\n`,
          );
        }
      }

      const ordered = ECOSYSTEM_ORDER.filter((eco) => ecosystems.has(eco));

      // Parse + resolve every ecosystem in parallel. Each section captures its
      // own error so a failure in one does not abort the others.
      const settled = await Promise.all(
        ordered.map((eco) =>
          resolveEcosystem(eco, githubRef, {
            includeTests,
            onProgress: appendProgress,
            packageInputs,
            pastedSection,
            downloadStats,
          })
            .then((section) =>
              section ? { ok: true, section } : { ok: false, ecosystem: eco, error: null },
            )
            .catch((err) => ({ ok: false, ecosystem: eco, error: err.message })),
        ),
      );

      progressDiv.hidden = true;

      // Enrich resolved packages with supply chain scores when the user has
      // provided a socket.dev API key, org slug, and a proxy URL is configured.
      let showSupplyChain = false;
      if (socketKey && socketOrg && SOCKET_PROXY_BASE && socketConsentCb.checked) {
        const allPkgs = [];
        for (const entry of settled) {
          if (!entry.ok) continue;
          const purlType = ECOSYSTEM_PURL_TYPE[entry.section.ecosystem];
          if (!purlType) continue;
          for (const pkg of entry.section.results.values()) {
            if (!pkg.error)
              allPkgs.push({ name: pkg.name, version: pkg.version, ecosystem: purlType });
          }
        }

        if (allPkgs.length > 0) {
          appendProgress("Fetching supply chain scores…\n");
          progressDiv.hidden = false;
          const socketScores = await fetchSocketScores(allPkgs, socketKey, socketOrg, {
            proxyBase: SOCKET_PROXY_BASE,
          });
          progressDiv.hidden = true;

          if (socketScores.size > 0) {
            showSupplyChain = true;
            for (const entry of settled) {
              if (!entry.ok) continue;
              const purlType = ECOSYSTEM_PURL_TYPE[entry.section.ecosystem];
              if (!purlType) continue;
              for (const pkg of entry.section.results.values()) {
                const key = scoreKey(purlType, pkg.name, pkg.version);
                const score = socketScores.get(key);
                if (score != null) pkg.supplyChain = score;
              }
            }
          }
        }
      }

      const showHeader = ordered.length >= 2;

      // Each section keeps its own sort state in its own closure.
      for (const entry of settled) {
        if (!entry.ok) {
          if (entry.error) renderSectionError(resultsDiv, entry.ecosystem, entry.error, showHeader);
          // entry.error === null means user cancelled the warning dialog — render nothing.
          continue;
        }

        const section = entry.section;
        let sortCol = "releaseDate";
        let sortDir = "desc";

        function rerender() {
          // Tear down the existing section element if it exists, then redraw.
          const prior = resultsDiv.querySelector(`section[data-ecosystem="${section.ecosystem}"]`);
          if (prior) prior.remove();

          const sortedRows = sortResultsBy(section.results, sortCol, sortDir);
          const sectionEl = renderSection(resultsDiv, {
            ecosystem: section.ecosystem,
            showHeader,
            sorted: sortedRows,
            directCount: section.directCount,
            source: section.source,
            note: section.note,
            privateCount: section.privateCount ?? 0,
            sortCol,
            sortDir,
            showDownloads:
              section.ecosystem === "rust" ||
              section.ecosystem === "npm" ||
              (section.downloadStats && section.ecosystem === "python"),
            showSupplyChain,
            socketSlug: showSupplyChain ? (SOCKET_URL_SLUG[section.ecosystem] ?? null) : null,
          });
          appendNonStandardSources(
            sectionEl,
            section.dangerousDeps ?? [],
            section.privatePkgs ?? [],
          );

          sectionEl.querySelectorAll("th[data-col]").forEach((th) => {
            const col = th.dataset.col;
            th.addEventListener("click", () => {
              if (sortCol === col) {
                sortDir = sortDir === "asc" ? "desc" : "asc";
              } else {
                sortCol = col;
                sortDir = col === "name" || col === "version" ? "asc" : "desc";
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
      setSubmitting(false);
    }
  });
}
