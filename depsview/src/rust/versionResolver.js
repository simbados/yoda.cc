/**
 * Cargo-flavoured SemVer resolver.
 *
 * Cargo follows SemVer 2.0 but diverges from npm in a few important ways:
 *   - A bare version like `"1.2.3"` is interpreted as a CARET requirement,
 *     not an exact pin. (npm treats it as `=1.2.3`.)
 *   - Multiple requirements are separated by COMMAS and joined with AND.
 *     Cargo has no `||` OR operator.
 *   - Wildcards: `*`, `1.*`, `1.2.*` (bare `*` is not accepted on crates.io
 *     uploads but appears in older transitive constraints).
 *
 * Caret rules — upper bound is the next increment of the leftmost non-zero
 * component (or, if all components are zero, the next patch):
 *   ^1.2.3 → >=1.2.3, <2.0.0
 *   ^0.2.3 → >=0.2.3, <0.3.0
 *   ^0.0.3 → >=0.0.3, <0.0.4
 *   ^1.2   → >=1.2.0, <2.0.0
 *   ^0.0   → >=0.0.0, <0.1.0
 *   ^0     → >=0.0.0, <1.0.0
 *
 * Tilde rules:
 *   ~1.2.3 → >=1.2.3, <1.3.0
 *   ~1.2   → >=1.2.0, <1.3.0
 *   ~1     → >=1.0.0, <2.0.0
 *
 * Reference:
 *   https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
 *   https://doc.rust-lang.org/cargo/reference/resolver.html
 */

/**
 * Parses a SemVer 2.0 version string into a comparable struct.
 * Build metadata (`+...`) is stripped per SemVer §10 (does not affect precedence).
 * Pre-release identifiers (`-...`) are split on dots; each component becomes a
 * number when numeric, otherwise a string.
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number, pre: Array<number|string>|null }}
 */
export function parseSemver(v) {
  const s = String(v).trim().split("+")[0];
  const dashIdx = s.indexOf("-");
  const core = dashIdx === -1 ? s : s.slice(0, dashIdx);
  const preStr = dashIdx === -1 ? null : s.slice(dashIdx + 1);

  const parts = core.split(".");
  const major = parseInt(parts[0], 10) || 0;
  const minor = parseInt(parts[1], 10) || 0;
  const patch = parseInt(parts[2], 10) || 0;

  const pre = preStr ? preStr.split(".").map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p)) : null;

  return { major, minor, patch, pre };
}

/**
 * Compares two parsed SemVer structs per SemVer §11 precedence rules.
 * Pre-release versions are less than the corresponding release. Among
 * pre-release identifiers, numeric components compare numerically and string
 * components compare lexically; numeric < string in mixed comparisons.
 * @param {ReturnType<parseSemver>} a
 * @param {ReturnType<parseSemver>} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.pre === null && b.pre !== null) return 1;
  if (a.pre !== null && b.pre === null) return -1;
  if (a.pre !== null && b.pre !== null) {
    const len = Math.max(a.pre.length, b.pre.length);
    for (let i = 0; i < len; i++) {
      if (i >= a.pre.length) return -1;
      if (i >= b.pre.length) return 1;
      const ai = a.pre[i],
        bi = b.pre[i];
      const aNum = typeof ai === "number",
        bNum = typeof bi === "number";
      if (aNum && bNum) {
        if (ai !== bi) return ai - bi;
        continue;
      }
      if (aNum) return -1;
      if (bNum) return 1;
      const cmp = String(ai).localeCompare(String(bi));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Returns true when a version string carries a pre-release identifier.
 * @param {string} v
 * @returns {boolean}
 */
export function isPreRelease(v) {
  try {
    return parseSemver(v).pre !== null;
  } catch {
    return false;
  }
}

/**
 * Expands a Cargo caret requirement into [>=lower, <upper] comparators.
 * @param {string} s - version portion (without leading `^`)
 * @returns {Array<{ op: string, ver: ReturnType<parseSemver> }>}
 */
function expandCaret(s) {
  const parts = s.split(".");
  const isWild = (p) => !p || /^[xX*]$/.test(p);

  const major = parseInt(parts[0], 10) || 0;
  const minor = parts.length >= 2 && !isWild(parts[1]) ? parseInt(parts[1], 10) || 0 : null;
  const patch = parts.length >= 3 && !isWild(parts[2]) ? parseInt(parts[2], 10) || 0 : null;

  const lower = parseSemver(`${major}.${minor ?? 0}.${patch ?? 0}`);

  let upper;
  if (major > 0) {
    upper = parseSemver(`${major + 1}.0.0`);
  } else if (minor === null) {
    upper = parseSemver("1.0.0");
  } else if (minor > 0) {
    upper = parseSemver(`0.${minor + 1}.0`);
  } else if (patch === null) {
    upper = parseSemver("0.1.0");
  } else if (patch > 0) {
    upper = parseSemver(`0.0.${patch + 1}`);
  } else {
    upper = parseSemver("0.0.1");
  }

  return [
    { op: ">=", ver: lower },
    { op: "<", ver: upper },
  ];
}

/**
 * Expands a Cargo tilde requirement into [>=lower, <upper] comparators.
 * @param {string} s - version portion (without leading `~`)
 * @returns {Array<{ op: string, ver: ReturnType<parseSemver> }>}
 */
function expandTilde(s) {
  const parts = s.split(".");
  const isWild = (p) => !p || /^[xX*]$/.test(p);

  const major = parseInt(parts[0], 10) || 0;
  const hasMinor = parts.length >= 2 && !isWild(parts[1]);
  const minor = hasMinor ? parseInt(parts[1], 10) || 0 : 0;
  const patch = parts.length >= 3 && !isWild(parts[2]) ? parseInt(parts[2], 10) || 0 : 0;

  const lower = parseSemver(`${major}.${minor}.${patch}`);
  const upper = hasMinor ? parseSemver(`${major}.${minor + 1}.0`) : parseSemver(`${major + 1}.0.0`);

  return [
    { op: ">=", ver: lower },
    { op: "<", ver: upper },
  ];
}

/**
 * Expands a Cargo wildcard requirement (`*`, `1.*`, `1.2.*`) into comparators.
 * A bare `*` matches anything; `1.*` is `>=1.0.0, <2.0.0`; `1.2.*` is
 * `>=1.2.0, <1.3.0`.
 * @param {string} s
 * @returns {Array<{ op: string, ver: ReturnType<parseSemver> }>}
 */
function expandWildcard(s) {
  const parts = s.split(".");
  const isWild = (p) => !p || /^[xX*]$/.test(p);

  if (isWild(parts[0])) return [];

  const major = parseInt(parts[0], 10) || 0;

  if (parts.length < 2 || isWild(parts[1])) {
    return [
      { op: ">=", ver: parseSemver(`${major}.0.0`) },
      { op: "<", ver: parseSemver(`${major + 1}.0.0`) },
    ];
  }

  const minor = parseInt(parts[1], 10) || 0;

  if (parts.length < 3 || isWild(parts[2])) {
    return [
      { op: ">=", ver: parseSemver(`${major}.${minor}.0`) },
      { op: "<", ver: parseSemver(`${major}.${minor + 1}.0`) },
    ];
  }

  return [{ op: "=", ver: parseSemver(s) }];
}

/**
 * Parses a single comma-free Cargo version comparator token (e.g. `^1.2`,
 * `>=1.0.0`, `1.0.5`, `1.*`) into expanded comparator objects.
 *
 * A bare numeric token like `"1.2.3"` defaults to a CARET requirement — this
 * is the key Cargo-vs-npm distinction.
 *
 * @param {string} token
 * @returns {Array<{ op: string, ver: ReturnType<parseSemver> }>}
 */
function parseComparatorToken(token) {
  const s = token.trim();
  if (!s || s === "*") return [];
  if (s.startsWith("^")) return expandCaret(s.slice(1).trim());
  if (s.startsWith("~")) return expandTilde(s.slice(1).trim());

  const opMatch = s.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (opMatch) {
    try {
      return [{ op: opMatch[1], ver: parseSemver(opMatch[2]) }];
    } catch {
      return [];
    }
  }

  if (/[xX*]/.test(s)) return expandWildcard(s);

  // Bare version → caret default (Cargo-specific behaviour).
  return expandCaret(s);
}

/**
 * Tests whether a parsed version satisfies one comparator.
 * @param {ReturnType<parseSemver>} v
 * @param {{ op: string, ver: ReturnType<parseSemver> }} comparator
 * @returns {boolean}
 */
function satisfiesComparator(v, { op, ver }) {
  const cmp = compareSemver(v, ver);
  switch (op) {
    case "=":
      return cmp === 0;
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    default:
      return true;
  }
}

/**
 * Tests whether a version string satisfies a Cargo version requirement string.
 * Multiple comma-separated comparators must ALL match. An empty / `*` / null
 * spec matches any version.
 * @param {string} versionStr
 * @param {string} reqStr
 * @returns {boolean}
 */
export function satisfiesRequirement(versionStr, reqStr) {
  if (!reqStr || reqStr.trim() === "" || reqStr.trim() === "*") return true;
  let v;
  try {
    v = parseSemver(versionStr);
  } catch {
    return false;
  }

  const comparators = reqStr.split(",").flatMap(parseComparatorToken);
  return comparators.every((c) => satisfiesComparator(v, c));
}

/**
 * Resolves the best matching version from a list of all published versions
 * for a given Cargo requirement string.
 *
 * Prefers stable (non-pre-release) versions unless the requirement itself
 * specifies a pre-release pin or no stable version satisfies the constraints.
 * Returns `{ version: null }` when nothing satisfies — callers must treat
 * null as an error (do not silently substitute the latest).
 *
 * @param {string|null} versionSpec - Cargo requirement string, e.g. `"^1.2.3"`, `"1.0"`, `">=1.0, <2.0"`
 * @param {string[]} allVersions
 * @returns {{ version: string|null, isLatest: boolean }}
 */
export function resolveVersion(versionSpec, allVersions) {
  if (!allVersions || allVersions.length === 0) return { version: "unknown", isLatest: true };

  const sortedDesc = (versions) =>
    [...versions].sort((a, b) => {
      try {
        return compareSemver(parseSemver(b), parseSemver(a));
      } catch {
        return 0;
      }
    });

  const spec = (versionSpec ?? "").trim();
  const isAny = !spec || spec === "*" || spec === "latest";

  if (isAny) {
    const stable = allVersions.filter((v) => !isPreRelease(v));
    const pool = stable.length > 0 ? stable : allVersions;
    const sorted = sortedDesc(pool);
    return { version: sorted[0], isLatest: true };
  }

  const sortedStable = sortedDesc(allVersions.filter((v) => !isPreRelease(v)));
  for (const v of sortedStable) {
    if (satisfiesRequirement(v, spec)) return { version: v, isLatest: v === sortedStable[0] };
  }

  const allSorted = sortedDesc(allVersions);
  for (const v of allSorted) {
    if (satisfiesRequirement(v, spec)) return { version: v, isLatest: v === allSorted[0] };
  }

  return { version: null, isLatest: false };
}
