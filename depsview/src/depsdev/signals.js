/**
 * Turns deps.dev findings records (see depsdev/client.js) into the per-package label
 * shown in the "deps.dev" column, its tooltip text, and the red-category banner.
 * Pure functions — no I/O, no input mutation. Browser-safe — no Node.js imports.
 *
 * Label → colour (severity order, most severe first):
 *   malicious, pulled          → red
 *   vulnerable, low usage      → orange
 *   deprecated, new, unknown   → yellow
 *   ok                         → green
 */

/**
 * Label definitions in severity order. `severity` is used for "worst label wins"
 * and for sorting (higher = worse). `color` is a semantic band that each output
 * maps to its own ANSI code / CSS class.
 */
const LABELS = [
  { label: "malicious", color: "red", severity: 7 },
  { label: "pulled", color: "red", severity: 6 },
  { label: "vulnerable", color: "orange", severity: 5 },
  { label: "low usage", color: "orange", severity: 4 },
  { label: "deprecated", color: "yellow", severity: 3 },
  { label: "new", color: "yellow", severity: 2 },
  { label: "unknown", color: "yellow", severity: 1 },
  { label: "ok", color: "green", severity: 0 },
];

const LABEL_INFO = new Map(LABELS.map((l) => [l.label, l]));

/** Maps a depsview ecosystem to the deps.dev website system slug. */
const DEPSDEV_SITE_SYSTEM = { npm: "npm", python: "pypi", go: "go", rust: "cargo" };

/**
 * Formats an ISO timestamp as YYYY-MM-DD, or returns the input unchanged when it
 * does not start with a date.
 * @param {string} iso
 * @returns {string}
 */
function shortDate(iso) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(iso);
  return m ? m[0] : iso;
}

/**
 * Classifies one deps.dev findings record into the label shown for a package.
 * Several findings → the most severe label is shown, `count` is the number of
 * distinct labels, and `details` holds one tooltip line per label.
 *
 * Mapping:
 *   MALICIOUS (package or version)              → malicious
 *   NOT_FOUND on the version, package exists    → pulled
 *   VULNERABLE (package or version)             → vulnerable
 *   LOW_USAGE                                   → low usage
 *   DEPRECATED (package or version)             → deprecated
 *   COOLDOWN on the version / cooldownEnd > now → new
 *   NOT_FOUND on the package                    → unknown
 *   none of the above                           → ok
 * Unknown finding types (and informational REMEDIATION on the installed version) are ignored.
 *
 * Example:
 *   classifyFindings({ versionFound: true, packageFindings: [],
 *     versionFindings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" },
 *                       { type: "DEPRECATED", risk: "RISK_MEDIUM", reason: "upgrade" }],
 *     cooldownEnd: null, recommended: { version: "1.2.0", types: ["REMEDIATION"] } }, "1.0.0")
 *   → { label: "vulnerable", color: "orange", severity: 5, count: 2,
 *       labels: ["vulnerable", "deprecated"],
 *       details: ["Affected by a critical vulnerability.", "Deprecated: upgrade"],
 *       recommended: "1.2.0", recommendedFixesVulnerability: true }
 *
 * @param {{ versionFound: boolean, versionFindings: object[], packageFindings: object[], cooldownEnd: string|null, recommended: { version: string, types: string[] }|null }|null|undefined} record
 * @param {string} installedVersion - the version depsview resolved (used to hide a no-op upgrade hint)
 * @param {Date} [now=new Date()]   - reference time for the cooldown check
 * @returns {{ label: string, color: string, severity: number, count: number, labels: string[], details: string[], recommended: string|null, recommendedFixesVulnerability: boolean }|null}
 *   null when there is no record (lookup failed or not requested)
 */
function classifyFindings(record, installedVersion, now = new Date()) {
  if (!record || typeof record !== "object") return null;

  const versionFindings = Array.isArray(record.versionFindings) ? record.versionFindings : [];
  const packageFindings = Array.isArray(record.packageFindings) ? record.packageFindings : [];
  const all = [...versionFindings, ...packageFindings];
  const hasType = (list, type) => list.some((f) => f.type === type);

  const packageMissing = hasType(packageFindings, "NOT_FOUND");
  const found = new Map(); // label → detail line (first one wins)
  const add = (label, detail) => {
    if (!found.has(label)) found.set(label, detail);
  };

  if (hasType(all, "MALICIOUS")) {
    add("malicious", "Flagged as malicious (OSSF Malicious Packages). Do not install.");
  }
  if (!packageMissing && hasType(versionFindings, "NOT_FOUND")) {
    add("pulled", "This version is no longer in the registry — often removed after a compromise.");
  }
  if (hasType(all, "VULNERABLE")) {
    add("vulnerable", "Affected by a critical vulnerability.");
  }
  const lowUsage = all.find((f) => f.type === "LOW_USAGE");
  if (lowUsage) {
    add(
      "low usage",
      lowUsage.alternatives?.length
        ? `Very low usage. Did you mean: ${lowUsage.alternatives.join(", ")}?`
        : "Very low usage — double-check the package name.",
    );
  }
  const deprecated =
    all.find((f) => f.type === "DEPRECATED" && f.reason) ??
    all.find((f) => f.type === "DEPRECATED");
  if (deprecated) {
    add("deprecated", deprecated.reason ? `Deprecated: ${deprecated.reason}` : "Deprecated.");
  }
  const cooldown = versionFindings.find((f) => f.type === "COOLDOWN");
  const cooldownEnd = cooldown?.until ?? record.cooldownEnd ?? null;
  const cooldownActive =
    Boolean(cooldown) ||
    (cooldownEnd != null &&
      !Number.isNaN(Date.parse(cooldownEnd)) &&
      Date.parse(cooldownEnd) > now.getTime());
  if (cooldownActive) {
    add(
      "new",
      cooldownEnd
        ? `Released recently — in cooldown until ${shortDate(cooldownEnd)}.`
        : "Released recently — in cooldown.",
    );
  }
  if (packageMissing) {
    add("unknown", "Not known to deps.dev (typo, very new, or private name?).");
  }
  if (found.size === 0) {
    add("ok", "No known issues found by deps.dev (this is not a guarantee).");
  }

  const labels = [...found.keys()].sort(
    (a, b) => LABEL_INFO.get(b).severity - LABEL_INFO.get(a).severity,
  );
  const top = LABEL_INFO.get(labels[0]);
  const recommended =
    record.recommended?.version && record.recommended.version !== installedVersion
      ? record.recommended.version
      : null;

  return {
    label: top.label,
    color: top.color,
    severity: top.severity,
    count: labels.length,
    labels,
    details: labels.map((l) => found.get(l)),
    recommended,
    recommendedFixesVulnerability: Boolean(
      recommended && record.recommended.types?.includes("REMEDIATION"),
    ),
  };
}

/**
 * Short cell text for the deps.dev column: the worst label plus a count of the others.
 *
 * Examples:
 *   depsDevCellText({ label: "vulnerable", count: 2 })  → "vulnerable +1"
 *   depsDevCellText({ label: "ok", count: 1 })          → "ok"
 *   depsDevCellText(null)                               → "-"
 *
 * @param {{ label: string, count: number }|null} classification
 * @param {string} [empty="-"] - text when there is no classification
 * @returns {string}
 */
function depsDevCellText(classification, empty = "-") {
  if (!classification) return empty;
  return classification.count > 1
    ? `${classification.label} +${classification.count - 1}`
    : classification.label;
}

/**
 * Multi-line tooltip text for a deps.dev cell: one line per finding, then the
 * recommended upgrade target when there is one.
 *
 * Example:
 *   depsDevTooltip({ details: ["Affected by a critical vulnerability."],
 *                    recommended: "1.2.0", recommendedFixesVulnerability: true })
 *   → "Affected by a critical vulnerability.\nRecommended: 1.2.0 (fixes a known vulnerability)"
 *
 * @param {{ details: string[], recommended: string|null, recommendedFixesVulnerability: boolean }|null} classification
 * @returns {string}
 */
function depsDevTooltip(classification) {
  if (!classification) return "";
  const lines = [...classification.details];
  if (classification.recommended) {
    lines.push(
      `Recommended: ${classification.recommended}` +
        (classification.recommendedFixesVulnerability ? " (fixes a known vulnerability)" : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Builds the red-category banner lines for one ecosystem section. Returns an empty
 * array when no package is malicious or pulled. A package that is both malicious and
 * pulled is listed only as malicious.
 *
 * Example:
 *   depsDevBannerLines([{ name: "lodahs", version: "1.0.0", depsDev: { labels: ["malicious", "pulled"] } },
 *                       { name: "ua-parser-js", version: "0.7.29", depsDev: { labels: ["pulled"] } }])
 *   → ["⚠ 1 package is flagged as malicious: lodahs@1.0.0. Do not install it — remove it from your dependencies.",
 *      "⚠ 1 locked version was pulled from the registry (often after a compromise): ua-parser-js@0.7.29. Upgrade or remove it."]
 *
 * @param {Array<{ name: string, version: string, depsDev?: { labels: string[] }|null }>} rows
 * @returns {string[]}
 */
function depsDevBannerLines(rows) {
  const malicious = [];
  const pulled = [];
  for (const r of rows) {
    const labels = r.depsDev?.labels ?? [];
    if (labels.includes("malicious")) malicious.push(`${r.name}@${r.version}`);
    else if (labels.includes("pulled")) pulled.push(`${r.name}@${r.version}`);
  }
  const lines = [];
  if (malicious.length) {
    const one = malicious.length === 1;
    lines.push(
      `⚠ ${malicious.length} package${one ? " is" : "s are"} flagged as malicious: ${malicious.join(", ")}. ` +
        `Do not install ${one ? "it" : "them"} — remove ${one ? "it" : "them"} from your dependencies.`,
    );
  }
  if (pulled.length) {
    const one = pulled.length === 1;
    lines.push(
      `⚠ ${pulled.length} locked version${one ? " was" : "s were"} pulled from the registry (often after a compromise): ` +
        `${pulled.join(", ")}. Upgrade or remove ${one ? "it" : "them"}.`,
    );
  }
  return lines;
}

/**
 * Returns the deps.dev website URL for a package version, with every path segment
 * percent-encoded (scoped npm names and Go module paths contain `@` and `/`).
 *
 * Examples:
 *   depsDevPackageUrl("npm", "@babel/core", "7.0.0")
 *     → "https://deps.dev/npm/%40babel%2Fcore/7.0.0"
 *   depsDevPackageUrl("go", "github.com/gin-gonic/gin", "v1.9.1")
 *     → "https://deps.dev/go/github.com%2Fgin-gonic%2Fgin/v1.9.1"
 *
 * @param {'npm'|'python'|'go'|'rust'} ecosystem
 * @param {string} name
 * @param {string} version
 * @returns {string|null} null for an unsupported ecosystem
 */
function depsDevPackageUrl(ecosystem, name, version) {
  const system = DEPSDEV_SITE_SYSTEM[ecosystem];
  if (!system || !name) return null;
  const base = `https://deps.dev/${system}/${encodeURIComponent(name)}`;
  return version ? `${base}/${encodeURIComponent(version)}` : base;
}

export {
  classifyFindings,
  depsDevCellText,
  depsDevTooltip,
  depsDevBannerLines,
  depsDevPackageUrl,
  LABELS,
};
