/**
 * Tests for src/formatter.js.
 * Verifies sort order (date descending, unknown last, alphabetical tiebreak)
 * and basic output correctness for both formatJson and formatTable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatTable,
  formatMulti,
  formatJson,
  daysSince,
  ECOSYSTEM_ORDER,
  ANSI_RED,
  ANSI_ORANGE,
  ANSI_YELLOW,
  ANSI_GREEN,
} from "../../src/output/formatter.js";

/**
 * Temporarily replaces console.log, runs fn(), then restores it.
 * Returns all lines logged during fn() joined with newlines.
 * @param {() => void} fn
 * @returns {string}
 */
function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

/**
 * Builds a results Map from a plain array of objects.
 * The Map key is the lowercase package name, matching what depResolver produces.
 * downloadsLastMonth defaults to null when omitted, mirroring what depResolver
 * stores when pypistats.org is unavailable for a package.
 * firstReleased defaults to 'unknown' when omitted.
 * @param {Array<{ name: string, version: string, released: string, firstReleased?: string, releases?: number, downloadsLastMonth?: number|null, error?: string }>} items
 * @returns {Map<string, object>}
 */
function makeResults(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.name.toLowerCase(), {
      name: item.name,
      version: item.version,
      releaseDate: item.released,
      firstReleaseDate: item.firstReleased ?? "unknown",
      releaseCount: item.releases ?? 0,
      downloadsLastMonth: item.downloadsLastMonth ?? null,
      error: item.error,
    });
  }
  return map;
}

/**
 * Wraps a results Map in a single-section structure and runs formatJson,
 * returning the rows array for the requested ecosystem. The formatter's
 * `formatJson` always emits a grouped object keyed by ecosystem; this helper
 * keeps the existing tests (which were written before grouping) terse.
 *
 * @param {Map<string, object>} results
 * @param {object} [opts]            - forwarded to formatJson
 * @param {'npm'|'python'|'go'} [ecosystem='python']
 * @returns {Array<object>}
 */
function runFormatJsonRows(results, opts = {}, ecosystem = "python") {
  const sections = new Map([[ecosystem, { results, directNames: new Set() }]]);
  // downloadStats defaults to true so the existing tests that expect
  // downloadsLastMonth in the JSON keep passing without modification.
  const merged = { downloadStats: true, ...opts };
  const output = captureConsole(() => formatJson(sections, merged));
  return JSON.parse(output)[ecosystem] ?? [];
}

// ── Sort order ────────────────────────────────────────────────────────────────

describe("sortedResults — date descending", () => {
  /**
   * The package with the most recent release date should appear first.
   */
  test("newest release appears first", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
      { name: "click", version: "8.1.3", released: "2022-04-28" },
      { name: "certifi", version: "2024.1.1", released: "2024-01-01" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].name, "certifi");
    assert.equal(rows[1].name, "requests");
    assert.equal(rows[2].name, "click");
  });

  /**
   * Descending order should hold regardless of the insertion order in the Map.
   */
  test("sort is independent of insertion order", () => {
    const results = makeResults([
      { name: "click", version: "8.1.3", released: "2022-04-28" },
      { name: "certifi", version: "2024.1.1", released: "2024-01-01" },
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].name, "certifi");
    assert.equal(rows[1].name, "requests");
    assert.equal(rows[2].name, "click");
  });

  /**
   * All dates returned should be in non-ascending (descending) order.
   */
  test("every date is >= the date of the following row", () => {
    const results = makeResults([
      { name: "a", version: "1.0", released: "2021-01-01" },
      { name: "b", version: "1.0", released: "2023-06-15" },
      { name: "c", version: "1.0", released: "2022-03-10" },
      { name: "d", version: "1.0", released: "2024-11-20" },
    ]);
    const rows = runFormatJsonRows(results);
    for (let i = 0; i < rows.length - 1; i++) {
      assert.ok(
        rows[i].released >= rows[i + 1].released,
        `Row ${i} (${rows[i].released}) should be >= row ${i + 1} (${rows[i + 1].released})`,
      );
    }
  });
});

describe("sortedResults — tiebreak on equal date", () => {
  /**
   * When two packages share the same release date, they should be sorted
   * alphabetically by name (ascending) so output is deterministic.
   */
  test("packages with the same date are sorted alphabetically", () => {
    const results = makeResults([
      { name: "urllib3", version: "2.0.0", released: "2023-03-10" },
      { name: "certifi", version: "2023.1", released: "2023-03-10" },
      { name: "requests", version: "2.28.0", released: "2023-03-10" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].name, "certifi");
    assert.equal(rows[1].name, "requests");
    assert.equal(rows[2].name, "urllib3");
  });
});

describe("sortedResults — unknown release date", () => {
  /**
   * Packages with "unknown" release dates must appear after all dated packages,
   * even if their names would sort before the dated ones alphabetically.
   */
  test("unknown date sinks to bottom below all dated packages", () => {
    const results = makeResults([
      { name: "aaa", version: "1.0", released: "unknown" },
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
      { name: "click", version: "8.1.3", released: "2022-04-28" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[rows.length - 1].name, "aaa");
  });

  /**
   * Multiple packages with unknown date should all be at the bottom,
   * sorted alphabetically among themselves.
   */
  test("multiple unknowns are sorted alphabetically among themselves", () => {
    const results = makeResults([
      { name: "zzz", version: "1.0", released: "unknown" },
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
      { name: "aaa", version: "1.0", released: "unknown" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].name, "requests");
    assert.equal(rows[1].name, "aaa");
    assert.equal(rows[2].name, "zzz");
  });

  /**
   * A map containing only unknown-dated packages should still produce output
   * (sorted alphabetically since all are tied at the bottom).
   */
  test("all-unknown map returns packages sorted alphabetically", () => {
    const results = makeResults([
      { name: "requests", version: "1.0", released: "unknown" },
      { name: "click", version: "1.0", released: "unknown" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].name, "click");
    assert.equal(rows[1].name, "requests");
  });
});

// ── formatJson ────────────────────────────────────────────────────────────────

describe("formatJson", () => {
  /**
   * Output must be valid JSON that can be parsed back.
   */
  test("produces valid JSON", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    assert.doesNotThrow(() => runFormatJsonRows(results));
  });

  /**
   * Each entry must have name, version, released, firstReleased, releases, downloadsLastMonth, and link fields.
   */
  test("each entry has name, version, released, firstReleased, releases, downloadsLastMonth, link fields", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        released: "2023-05-22",
        firstReleased: "2011-02-14",
        releases: 42,
        downloadsLastMonth: 5000000,
      },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows.length, 1);
    assert.ok("name" in rows[0]);
    assert.ok("version" in rows[0]);
    assert.ok("released" in rows[0]);
    assert.ok("firstReleased" in rows[0]);
    assert.ok("releases" in rows[0]);
    assert.ok("downloadsLastMonth" in rows[0]);
    assert.ok("link" in rows[0]);
  });

  /**
   * The link field must be the canonical PyPI URL for the package.
   */
  test("link field contains the correct PyPI URL", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].link, "https://pypi.org/project/requests/");
  });

  /**
   * The firstReleased field should reflect the value passed in.
   */
  test("firstReleased field contains the correct date", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", firstReleased: "2011-02-14" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].firstReleased, "2011-02-14");
  });

  /**
   * When firstReleased is not provided it should default to "unknown".
   */
  test('firstReleased defaults to "unknown" when not provided', () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].firstReleased, "unknown");
  });

  /**
   * The releases field must reflect the count passed in, not a default or transformed value.
   */
  test("releases field contains the correct count", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", releases: 87 },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].releases, 87);
  });

  /**
   * When no releases count is provided, the field defaults to 0.
   */
  test("releases field defaults to 0 when not provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].releases, 0);
  });

  /**
   * The downloadsLastMonth field should reflect the value passed in.
   */
  test("downloadsLastMonth field contains the correct value", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: 34567890 },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].downloadsLastMonth, 34567890);
  });

  /**
   * When downloadsLastMonth is not provided it should default to null in the output,
   * not 0 or undefined, so consumers can distinguish "no data" from "zero downloads".
   */
  test("downloadsLastMonth defaults to null when not provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].downloadsLastMonth, null);
  });

  /**
   * Packages with an error field should include it in the JSON output.
   */
  test("error field is included when present", () => {
    const results = makeResults([
      { name: "broken", version: "error", released: "unknown", error: "Package not found on PyPI" },
    ]);
    const rows = runFormatJsonRows(results);
    assert.equal(rows[0].error, "Package not found on PyPI");
  });

  /**
   * Packages without an error should not have an error field in the JSON.
   */
  test("error field is absent when not present", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.ok(!("error" in rows[0]));
  });

  /**
   * An empty results map should produce an empty JSON array, not throw.
   */
  test("empty results produce empty JSON array", () => {
    const rows = runFormatJsonRows(new Map());
    assert.deepEqual(rows, []);
  });
});

// ── formatTable ───────────────────────────────────────────────────────────────

describe("formatTable", () => {
  /**
   * An empty results map should print a "No dependencies found" message
   * rather than an empty table with headers.
   */
  test('prints "No dependencies found" for empty map', () => {
    const output = captureConsole(() => formatTable(new Map(), new Set()));
    assert.ok(output.includes("No dependencies found"));
  });

  /**
   * The footer should correctly report the total count and the direct/transitive split.
   */
  test("footer reports correct total and direct count", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
      { name: "urllib3", version: "2.0.0", released: "2023-03-10" },
    ]);
    const directNames = new Set(["requests"]);
    const output = captureConsole(() => formatTable(results, directNames));
    assert.ok(output.includes("2 packages total"));
    assert.ok(output.includes("1 direct"));
    assert.ok(output.includes("1 transitive"));
  });

  /**
   * The table header should contain all seven column labels including First Release, Downloads/mo, and Link.
   */
  test("table includes all seven column headers", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        released: "2023-05-22",
        firstReleased: "2011-02-14",
        releases: 42,
        downloadsLastMonth: 1000,
      },
    ]);
    const output = captureConsole(() => formatTable(results, new Set(), { downloadStats: true }));
    assert.ok(output.includes("Package"));
    assert.ok(output.includes("Version"));
    assert.ok(output.includes("Released"));
    assert.ok(output.includes("First Release"));
    assert.ok(output.includes("Releases"));
    assert.ok(output.includes("Downloads/mo"));
    assert.ok(output.includes("Link"));
  });

  /**
   * The Link column must contain the PyPI URL for each package.
   */
  test("Link column contains the PyPI URL for the package", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(
      output.includes("https://pypi.org/project/requests/"),
      `Expected PyPI URL in:\n${output}`,
    );
  });

  /**
   * The first release date should appear in the table row for the corresponding package.
   */
  test("first release date appears in the table row", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", firstReleased: "2011-02-14" },
    ]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(output.includes("2011-02-14"), `Expected first release date in:\n${output}`);
  });

  /**
   * The release count should appear in the table row for the corresponding package.
   */
  test("release count appears in the table row", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        released: "2023-05-22",
        releases: 87,
        downloadsLastMonth: 1000,
      },
    ]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(output.includes("87"), `Expected release count 87 in output:\n${output}`);
  });

  /**
   * A null downloadsLastMonth should render as "-" in the table, not "0" or "null",
   * so it is clear the data is unavailable rather than zero.
   */
  test('null downloadsLastMonth renders as "-" in the table', () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: null },
    ]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(output.includes("-"), `Expected "-" for missing stats in:\n${output}`);
  });

  /**
   * Download counts should be formatted with thousand separators so large numbers
   * are readable at a glance (e.g. 34,567,890 not 34567890).
   */
  test("download count is formatted with thousand separators", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: 34567890 },
    ]);
    const output = captureConsole(() => formatTable(results, new Set(), { downloadStats: true }));
    assert.ok(output.includes("34,567,890"), `Expected formatted number in:\n${output}`);
  });

  /**
   * Packages appear in the table in date-descending order — the first data row
   * (after the header divider) should be the package with the newest release.
   */
  test("first data row is the package with the newest release date", () => {
    const results = makeResults([
      { name: "click", version: "8.1.3", released: "2022-04-28" },
      { name: "requests", version: "2.31.0", released: "2023-05-22" },
    ]);
    const output = captureConsole(() => formatTable(results, new Set()));
    // Find the first line that contains package data (after the two header lines)
    const lines = output.split("\n").filter((l) => l.trim() && !l.startsWith("-"));
    const dataLines = lines.slice(1); // skip the header row
    assert.ok(dataLines[0].includes("requests"), `Expected requests first, got: ${dataLines[0]}`);
  });

  /**
   * No ANSI escape codes should appear in the table output when stdout is not a
   * TTY (the default in test environments). This prevents garbled output when the
   * tool is piped or run in CI.
   */
  test("no ANSI codes in output when stdout is not a TTY", () => {
    const results = makeResults([
      { name: "new-pkg", version: "1.0.0", released: "2026-04-26", firstReleased: "2026-04-01" },
      { name: "requests", version: "2.31.0", released: "2023-05-22", firstReleased: "2011-02-14" },
    ]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(!output.includes("\x1b["), `ANSI codes found in non-TTY output:\n${output}`);
  });
});

// ── formatTable — downloadStats: false ───────────────────────────────────────

describe("formatTable — downloadStats: false", () => {
  /**
   * When download stats are not fetched the Downloads/mo column header must be absent
   * so users don't see an empty or misleading column.
   */
  test("omits the Downloads/mo column header", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: null },
    ]);
    const output = captureConsole(() => formatTable(results, new Set(), { downloadStats: false }));
    assert.ok(
      !output.includes("Downloads/mo"),
      "Downloads/mo header must not appear when downloadStats is false",
    );
  });

  /**
   * The five remaining column headers must still be present.
   */
  test("still shows Package, Version, Released, First Release, Releases headers", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const output = captureConsole(() => formatTable(results, new Set(), { downloadStats: false }));
    assert.ok(output.includes("Package"));
    assert.ok(output.includes("Version"));
    assert.ok(output.includes("Released"));
    assert.ok(output.includes("First Release"));
    assert.ok(output.includes("Releases"));
  });
});

// ── formatJson — downloadStats: false ────────────────────────────────────────

describe("formatJson — downloadStats: false", () => {
  /**
   * downloadsLastMonth must be omitted entirely from the JSON so machine consumers
   * don't see a column of null values that could be confused with actual zeros.
   */
  test("omits downloadsLastMonth from each entry", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: null },
    ]);
    const rows = runFormatJsonRows(results, { downloadStats: false });
    assert.ok(
      !("downloadsLastMonth" in rows[0]),
      "downloadsLastMonth must not appear in JSON when downloadStats is false",
    );
  });

  /**
   * All other fields must still be present including link.
   */
  test("still includes name, version, released, firstReleased, releases, link", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        released: "2023-05-22",
        firstReleased: "2011-02-14",
        releases: 42,
      },
    ]);
    const rows = runFormatJsonRows(results, { downloadStats: false });
    assert.ok("name" in rows[0]);
    assert.ok("version" in rows[0]);
    assert.ok("released" in rows[0]);
    assert.ok("firstReleased" in rows[0]);
    assert.ok("releases" in rows[0]);
    assert.ok("link" in rows[0]);
  });

  /**
   * downloadsLastMonth must be present when downloadStats is true (the default).
   */
  test("includes downloadsLastMonth when downloadStats is true", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", released: "2023-05-22", downloadsLastMonth: 1234 },
    ]);
    const rows = runFormatJsonRows(results, { downloadStats: true });
    assert.ok("downloadsLastMonth" in rows[0]);
    assert.equal(rows[0].downloadsLastMonth, 1234);
  });
});

// ── daysSince ─────────────────────────────────────────────────────────────────

describe("daysSince", () => {
  /**
   * A date exactly N days in the past should return N.
   */
  test("returns correct number of whole days for a past date", () => {
    const now = new Date("2026-04-27T12:00:00Z");
    const result = daysSince("2026-04-20", now);
    assert.equal(result, 7);
  });

  /**
   * Today's date should return 0.
   */
  test("returns 0 for today", () => {
    const now = new Date("2026-04-27T12:00:00Z");
    assert.equal(daysSince("2026-04-27", now), 0);
  });

  /**
   * "unknown" should return Infinity so it never matches a recency threshold.
   */
  test('returns Infinity for "unknown"', () => {
    assert.equal(daysSince("unknown", new Date()), Infinity);
  });

  /**
   * null or empty string should also return Infinity.
   */
  test("returns Infinity for null or empty string", () => {
    assert.equal(daysSince(null, new Date()), Infinity);
    assert.equal(daysSince("", new Date()), Infinity);
  });
});

// ── color thresholds ──────────────────────────────────────────────────────────

describe("color thresholds via daysSince", () => {
  const now = new Date("2026-04-27");

  // Red tier: <= 3 days
  test("released 3 days ago qualifies for red", () => {
    assert.ok(daysSince("2026-04-24", now) <= 3);
  });

  test("released exactly 3 days ago qualifies for red (inclusive)", () => {
    assert.ok(daysSince("2026-04-24", now) <= 3);
  });

  test("released 4 days ago does not qualify for red", () => {
    assert.ok(daysSince("2026-04-23", now) > 3);
  });

  // Orange tier: 4–7 days
  test("released 5 days ago qualifies for orange", () => {
    const age = daysSince("2026-04-22", now);
    assert.ok(age > 3 && age <= 7);
  });

  test("released exactly 7 days ago qualifies for orange (inclusive)", () => {
    assert.ok(daysSince("2026-04-20", now) <= 7);
  });

  test("released 8 days ago does not qualify for orange", () => {
    assert.ok(daysSince("2026-04-19", now) > 7);
  });

  // Yellow tier: 8–30 days
  test("released 10 days ago qualifies for yellow", () => {
    const age = daysSince("2026-04-17", now);
    assert.ok(age > 7 && age <= 30);
  });

  test("released exactly 30 days ago qualifies for yellow (inclusive)", () => {
    assert.ok(daysSince("2026-03-28", now) <= 30);
  });

  test("released 31 days ago does not qualify for any color tier", () => {
    assert.ok(daysSince("2026-03-27", now) > 30);
  });

  // Both thresholds can apply to different columns simultaneously
  test("both columns can independently hit different tiers", () => {
    const firstReleased = "2026-04-20"; // 7 days ago  → orange
    const released = "2026-04-25"; // 2 days ago  → red
    assert.ok(daysSince(firstReleased, now) <= 7);
    assert.ok(daysSince(released, now) <= 3);
  });

  // ANSI constant sanity checks
  test("ANSI_RED is the standard red escape sequence", () => {
    assert.equal(ANSI_RED, "\x1b[31m");
  });

  test("ANSI_ORANGE is the 256-colour orange escape sequence", () => {
    assert.equal(ANSI_ORANGE, "\x1b[38;5;208m");
  });

  test("ANSI_YELLOW is the standard yellow escape sequence", () => {
    assert.equal(ANSI_YELLOW, "\x1b[33m");
  });

  test("ANSI_GREEN is the standard green escape sequence", () => {
    assert.equal(ANSI_GREEN, "\x1b[32m");
  });
});

// ── Supply Chain column — formatTable ─────────────────────────────────────────

describe("formatTable — socketScores", () => {
  /**
   * When socketScores is provided, the Supply Chain header must appear in the output.
   */
  test("shows Supply Chain column header when socketScores provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const socketScores = new Map([["requests@2.31.0", 0.87]]);
    const output = captureConsole(() => formatTable(results, new Set(), { socketScores }));
    assert.ok(output.includes("Supply Chain"), `Expected "Supply Chain" header in:\n${output}`);
  });

  /**
   * Without socketScores the Supply Chain header must not appear.
   */
  test("omits Supply Chain column when socketScores not provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const output = captureConsole(() => formatTable(results, new Set()));
    assert.ok(
      !output.includes("Supply Chain"),
      "Supply Chain header must not appear without socketScores",
    );
  });

  /**
   * A score of 0.87 should render as "87%" in the table row.
   */
  test("renders score as percentage in table row", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const socketScores = new Map([["requests@2.31.0", 0.87]]);
    const output = captureConsole(() => formatTable(results, new Set(), { socketScores }));
    assert.ok(output.includes("87%"), `Expected "87%" in:\n${output}`);
  });

  /**
   * A package not found in socketScores should render as "-" in the Supply Chain cell.
   */
  test('renders "-" when package has no score in socketScores', () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const socketScores = new Map(); // empty — no scores
    const output = captureConsole(() => formatTable(results, new Set(), { socketScores }));
    assert.ok(output.includes("Supply Chain"), "header must appear");
    assert.ok(output.includes("-"), "dash must appear for missing score");
  });

  /**
   * An empty socketScores Map still triggers the column (column is shown, all cells are "-").
   */
  test("shows column even when socketScores Map is empty", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const output = captureConsole(() =>
      formatTable(results, new Set(), { socketScores: new Map() }),
    );
    assert.ok(output.includes("Supply Chain"));
  });
});

// ── Supply Chain field — formatJson ───────────────────────────────────────────

describe("formatJson — socketScores", () => {
  /**
   * When socketScores is provided, each entry should include supplyChainScore.
   */
  test("includes supplyChainScore when socketScores provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    // Score keys are ecosystem-tagged so multi-ecosystem reports share one map.
    const socketScores = new Map([["pypi:requests@2.31.0", 0.87]]);
    const rows = runFormatJsonRows(results, { socketScores });
    assert.ok("supplyChainScore" in rows[0], "supplyChainScore must be present");
    assert.equal(rows[0].supplyChainScore, 0.87);
  });

  /**
   * When socketScores is not provided, supplyChainScore must be absent.
   */
  test("omits supplyChainScore when socketScores not provided", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results);
    assert.ok(
      !("supplyChainScore" in rows[0]),
      "supplyChainScore must not appear without socketScores",
    );
  });

  /**
   * A package not present in socketScores should have supplyChainScore: null.
   */
  test("supplyChainScore is null when package not in socketScores", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const socketScores = new Map(); // empty
    const rows = runFormatJsonRows(results, { socketScores });
    assert.equal(rows[0].supplyChainScore, null);
  });

  /**
   * An empty socketScores Map still adds the supplyChainScore field (value null).
   */
  test("adds supplyChainScore field even with empty socketScores Map", () => {
    const results = makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]);
    const rows = runFormatJsonRows(results, { socketScores: new Map() });
    assert.ok("supplyChainScore" in rows[0]);
  });
});

// ── Multi-section output ──────────────────────────────────────────────────────

describe("formatJson — grouped multi-section output", () => {
  test("emits one top-level key per ecosystem in fixed order: npm, python, go", () => {
    const sections = new Map([
      [
        "go",
        {
          results: makeResults([
            { name: "github.com/gin-gonic/gin", version: "v1.9.1", released: "2023-06-01" },
          ]),
          directNames: new Set(),
        },
      ],
      [
        "npm",
        {
          results: makeResults([{ name: "express", version: "4.19.2", released: "2024-03-25" }]),
          directNames: new Set(),
        },
      ],
      [
        "python",
        {
          results: makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections));
    const obj = JSON.parse(output);
    assert.deepEqual(Object.keys(obj), ["npm", "python", "go"]);
  });

  test("omits firstReleased entries for Go sections", () => {
    const sections = new Map([
      [
        "go",
        {
          results: makeResults([
            { name: "github.com/gin-gonic/gin", version: "v1.9.1", released: "2023-06-01" },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections));
    const obj = JSON.parse(output);
    assert.ok(!("firstReleased" in obj.go[0]));
  });

  test("downloadsLastMonth: python opt-in, npm always, go never", () => {
    const sections = new Map([
      [
        "python",
        {
          results: makeResults([
            {
              name: "requests",
              version: "2.31.0",
              released: "2023-05-22",
              downloadsLastMonth: 100,
            },
          ]),
          directNames: new Set(),
        },
      ],
      [
        "npm",
        {
          results: makeResults([
            { name: "express", version: "4.19.2", released: "2024-03-25", downloadsLastMonth: 200 },
          ]),
          directNames: new Set(),
        },
      ],
      [
        "go",
        {
          results: makeResults([
            { name: "github.com/gin-gonic/gin", version: "v1.9.1", released: "2023-06-01" },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections, { downloadStats: true }));
    const obj = JSON.parse(output);
    assert.ok("downloadsLastMonth" in obj.python[0]);
    assert.ok("downloadsLastMonth" in obj.npm[0]);
    assert.ok(!("downloadsLastMonth" in obj.go[0]));
  });

  test("npm downloadsLastMonth is included even when downloadStats is false", () => {
    const sections = new Map([
      [
        "npm",
        {
          results: makeResults([
            { name: "express", version: "4.19.2", released: "2024-03-25", downloadsLastMonth: 200 },
          ]),
          directNames: new Set(),
        },
      ],
      [
        "python",
        {
          results: makeResults([
            {
              name: "requests",
              version: "2.31.0",
              released: "2023-05-22",
              downloadsLastMonth: 100,
            },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections));
    const obj = JSON.parse(output);
    assert.ok("downloadsLastMonth" in obj.npm[0]);
    assert.ok(!("downloadsLastMonth" in obj.python[0]));
  });

  test("skips ecosystems not present in the sections map", () => {
    const sections = new Map([
      [
        "npm",
        {
          results: makeResults([{ name: "express", version: "4.19.2", released: "2024-03-25" }]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections));
    const obj = JSON.parse(output);
    assert.deepEqual(Object.keys(obj), ["npm"]);
  });
});

describe("formatMulti — multi-section text output", () => {
  test("emits section headers in fixed order when ≥2 ecosystems are present", () => {
    const sections = new Map([
      [
        "python",
        {
          results: makeResults([{ name: "requests", version: "2.31.0", released: "2023-05-22" }]),
          directNames: new Set(),
        },
      ],
      [
        "npm",
        {
          results: makeResults([{ name: "express", version: "4.19.2", released: "2024-03-25" }]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatMulti(sections));
    const npmIdx = output.indexOf("=== npm ===");
    const pyIdx = output.indexOf("=== python ===");
    assert.ok(npmIdx >= 0, "expected npm section header");
    assert.ok(pyIdx >= 0, "expected python section header");
    assert.ok(npmIdx < pyIdx, "npm should come before python in render order");
  });

  test("omits section headers when only one ecosystem is present", () => {
    const sections = new Map([
      [
        "npm",
        {
          results: makeResults([{ name: "express", version: "4.19.2", released: "2024-03-25" }]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatMulti(sections));
    assert.ok(!output.includes("=== npm ==="));
  });

  test("omits the First Release column header for Go sections", () => {
    const sections = new Map([
      [
        "go",
        {
          results: makeResults([
            { name: "github.com/gin-gonic/gin", version: "v1.9.1", released: "2023-06-01" },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatMulti(sections));
    assert.ok(!output.includes("First Release"));
  });
});

// ── Rust downloads column — formatTable ───────────────────────────────────────

describe("formatTable — rust downloadsLabel", () => {
  /**
   * The downloadsLabel opt overrides the default "Downloads/mo" heading so Rust
   * can show crates.io's 90-day figure under a distinct column name.
   */
  test("uses the custom downloadsLabel as the column header", () => {
    const results = makeResults([
      { name: "serde", version: "1.0.197", released: "2024-02-01", downloadsLastMonth: 233815725 },
    ]);
    const output = captureConsole(() =>
      formatTable(results, new Set(), {
        ecosystem: "rust",
        downloadStats: true,
        downloadsLabel: "Downloads (90d)",
      }),
    );
    assert.ok(
      output.includes("Downloads (90d)"),
      `Expected "Downloads (90d)" header in:\n${output}`,
    );
    assert.ok(
      !output.includes("Downloads/mo"),
      "default label must not appear when downloadsLabel is set",
    );
  });

  /**
   * The formatted 90-day count must appear in the data row.
   */
  test("renders the 90-day download count in the row", () => {
    const results = makeResults([
      { name: "serde", version: "1.0.197", released: "2024-02-01", downloadsLastMonth: 233815725 },
    ]);
    const output = captureConsole(() =>
      formatTable(results, new Set(), {
        ecosystem: "rust",
        downloadStats: true,
        downloadsLabel: "Downloads (90d)",
      }),
    );
    assert.ok(output.includes("233,815,725"), `Expected formatted count in:\n${output}`);
  });
});

// ── Rust downloads column — formatMulti / formatJson ──────────────────────────

describe("rust downloads via formatMulti", () => {
  /**
   * Rust always shows a downloads column even when downloadStats is false,
   * labelled with crates.io's 90-day heading.
   */
  test("rust section always renders the Downloads (90d) column without downloadStats", () => {
    const sections = new Map([
      [
        "rust",
        {
          results: makeResults([
            {
              name: "serde",
              version: "1.0.197",
              released: "2024-02-01",
              downloadsLastMonth: 233815725,
            },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatMulti(sections, { downloadStats: false }));
    assert.ok(output.includes("Downloads (90d)"), `Expected rust downloads header in:\n${output}`);
    assert.ok(output.includes("233,815,725"), `Expected rust download count in:\n${output}`);
  });

  /**
   * The Python heading must never leak into the Rust section.
   */
  test("rust section does not use the Downloads/mo label", () => {
    const sections = new Map([
      [
        "rust",
        {
          results: makeResults([
            { name: "serde", version: "1.0.197", released: "2024-02-01", downloadsLastMonth: 1 },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatMulti(sections, { downloadStats: false }));
    assert.ok(!output.includes("Downloads/mo"), "rust must not use the Downloads/mo label");
  });
});

describe("formatJson — rust downloadsLastMonth", () => {
  /**
   * Rust JSON always includes downloadsLastMonth regardless of the downloadStats flag.
   */
  test("rust section includes downloadsLastMonth without downloadStats", () => {
    const sections = new Map([
      [
        "rust",
        {
          results: makeResults([
            {
              name: "serde",
              version: "1.0.197",
              released: "2024-02-01",
              downloadsLastMonth: 233815725,
            },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections, { downloadStats: false }));
    const obj = JSON.parse(output);
    assert.ok("downloadsLastMonth" in obj.rust[0], "downloadsLastMonth must be present for rust");
    assert.equal(obj.rust[0].downloadsLastMonth, 233815725);
  });

  /**
   * A null recent-downloads value is preserved as null (not omitted) for rust.
   */
  test("rust section keeps a null downloadsLastMonth", () => {
    const sections = new Map([
      [
        "rust",
        {
          results: makeResults([
            { name: "serde", version: "1.0.197", released: "2024-02-01", downloadsLastMonth: null },
          ]),
          directNames: new Set(),
        },
      ],
    ]);
    const output = captureConsole(() => formatJson(sections, { downloadStats: false }));
    const obj = JSON.parse(output);
    assert.ok("downloadsLastMonth" in obj.rust[0]);
    assert.equal(obj.rust[0].downloadsLastMonth, null);
  });
});

describe("ECOSYSTEM_ORDER", () => {
  test("is the fixed npm → python → go → rust sequence", () => {
    assert.deepEqual(ECOSYSTEM_ORDER, ["npm", "python", "go", "rust"]);
  });
});
