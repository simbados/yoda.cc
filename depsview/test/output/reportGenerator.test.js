/**
 * Tests for src/output/reportGenerator.js.
 * generateReport is a pure function (returns an HTML string) so all tests
 * simply call it and assert on the returned string — no DOM or fs required.
 *
 * Architecture note: table rows are rendered entirely client-side by the
 * embedded sort script, so package data (names, versions, dates, scores)
 * lives in the embedded JSON blob rather than in static HTML. Tests that
 * previously checked for row content in the HTML now verify the JSON data
 * and the security properties of the script.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateReport as generateReportRaw } from "../../src/output/reportGenerator.js";

/**
 * Builds a results Map in the same shape that depResolver produces.
 * @param {Array<object>} items
 * @returns {Map<string, object>}
 */
function makeResults(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.name.toLowerCase(), {
      name: item.name,
      version: item.version,
      releaseDate: item.releaseDate ?? "unknown",
      firstReleaseDate: item.firstReleaseDate ?? "unknown",
      releaseCount: item.releaseCount ?? 0,
      downloadsLastMonth: item.downloadsLastMonth ?? null,
      link: item.link ?? `https://pypi.org/project/${item.name}/`,
      error: item.error,
    });
  }
  return map;
}

/**
 * Test shim that wraps a single (results, directNames) pair into the
 * sections Map that the production `generateReport` now expects.
 */
function generateReport(results, directNames = new Set(), opts = {}) {
  const ecosystem = opts.ecosystem ?? "python";
  const source = opts.source ?? null;
  const { ecosystem: _e, source: _s, ...rendererOpts } = opts;
  const sections = new Map([[ecosystem, { results, directNames, source, note: null }]]);
  return generateReportRaw(sections, { downloadStats: true, ...rendererOpts });
}

/**
 * Extracts and parses the JSON data block embedded in the sort script.
 * The block is `var D={...};` immediately before `var state=`.
 * Returns the parsed { sections: [...] } object.
 */
function extractScriptData(html) {
  const start = html.indexOf("var D=") + 6;
  assert.ok(start > 5, "Could not find embedded script data (var D=) in HTML");
  const end = html.indexOf(";\nvar state=", start);
  assert.ok(end > start, "Could not find end of embedded script data in HTML");
  return JSON.parse(html.slice(start, end));
}

// ── HTML structure ─────────────────────────────────────────────────────────────

describe("generateReport — HTML structure", () => {
  it("returns a complete HTML document", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE");
    assert.ok(html.includes("</html>"), "must end with closing html tag");
  });

  it('sets the page title to "Dependency Report"', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("<title>Dependency Report</title>"));
  });

  it("embeds a <style> block (self-contained, no external CSS)", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("<style>"), "must embed inline styles");
    assert.ok(!html.includes('<link rel="stylesheet"'), "must not reference external CSS");
  });

  it('renders the "Dependency Report" heading', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("Dependency Report"));
  });

  it("emits an empty <tbody> — rows are rendered client-side", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes("<tbody></tbody>"), "<tbody> must be empty in the static HTML");
  });
});

// ── Meta line ──────────────────────────────────────────────────────────────────

describe("generateReport — meta line", () => {
  it("includes the ecosystem label when provided", () => {
    const html = generateReport(new Map(), new Set(), { ecosystem: "npm" });
    assert.ok(html.includes("npm"));
  });

  it("includes the source file name when provided", () => {
    const html = generateReport(new Map(), new Set(), { source: "package-lock.json" });
    assert.ok(html.includes("package-lock.json"));
  });

  it("includes a UTC timestamp", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("UTC"));
  });
});

// ── Summary line ───────────────────────────────────────────────────────────────

describe("generateReport — summary line", () => {
  it('shows "0 packages total" for an empty map', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("0 packages total"));
  });

  it("shows correct total count", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
      { name: "certifi", version: "2024.1", releaseDate: "2024-01-01" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes("2 packages total"));
  });

  it("shows direct and transitive breakdown when directNames is non-empty", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
      { name: "urllib3", version: "2.0.0", releaseDate: "2023-03-10" },
    ]);
    const directNames = new Set(["requests"]);
    const html = generateReport(results, directNames);
    assert.ok(html.includes("1 direct"));
    assert.ok(html.includes("1 transitive"));
  });

  it("omits the direct/transitive breakdown when directNames is empty", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(!html.includes("direct"), 'must not mention "direct" when directNames is empty');
  });
});

// ── Table columns ─────────────────────────────────────────────────────────────

describe("generateReport — table columns", () => {
  it("renders all default column headers", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    for (const header of [
      "Package",
      "Version",
      "Released",
      "First Release",
      "Releases",
      "Downloads/mo",
    ]) {
      assert.ok(html.includes(header), `Expected column header "${header}"`);
    }
    assert.ok(!html.includes("<th>Link</th>"), "Link column must not appear (name already links)");
  });

  it("omits the Downloads/mo column when downloadStats is false", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set(), { downloadStats: false });
    assert.ok(!html.includes("Downloads/mo"), "Downloads/mo column must be absent");
  });

  it("adds the Supply Chain column when socketScores is provided", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set(), { socketScores: new Map() });
    assert.ok(html.includes("Supply Chain"), "Supply Chain column must appear");
  });

  it("omits the Supply Chain column when socketScores is not provided", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(
      !html.includes("Supply Chain"),
      "Supply Chain column must not appear without socketScores",
    );
  });
});

// ── Embedded script JSON ───────────────────────────────────────────────────────

describe("generateReport — embedded script JSON", () => {
  it("embeds the package name in the rows array", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.ok(row, "requests must be present in the embedded rows");
  });

  it("embeds the registry link in the row", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        releaseDate: "2023-05-22",
        link: "https://pypi.org/project/requests/",
      },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.equal(row.link, "https://pypi.org/project/requests/");
  });

  it("embeds the version in the row", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.equal(row.version, "2.31.0");
  });

  it("embeds the release date in the row", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.equal(row.released, "2023-05-22");
  });

  it("embeds the first release date in the row", () => {
    const results = makeResults([
      {
        name: "requests",
        version: "2.31.0",
        releaseDate: "2023-05-22",
        firstReleaseDate: "2011-02-14",
      },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.equal(row.firstReleased, "2011-02-14");
  });

  it("embeds the release count in the row", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22", releaseCount: 144 },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.equal(row.releases, 144);
  });

  it("embeds the supply chain score in the row", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const socketScores = new Map([["pypi:requests@2.31.0", 0.87]]);
    const data = extractScriptData(generateReport(results, new Set(), { socketScores }));
    const row = data.sections[0].rows.find((r) => r.name === "requests");
    assert.ok(Math.abs(row.supplyChain - 0.87) < 0.001);
  });

  it("embeds the socketSlug so the script can build socket.dev links", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set(), {
      socketScores: new Map([["pypi:requests@2.31.0", 0.87]]),
      ecosystem: "python",
    });
    const data = extractScriptData(html);
    assert.equal(data.sections[0].socketSlug, "pypi");
  });

  it("rows are ordered newest-first in the embedded JSON", () => {
    const results = makeResults([
      { name: "old", version: "1.0.0", releaseDate: "2020-01-01" },
      { name: "new", version: "2.0.0", releaseDate: "2024-06-01" },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const rows = data.sections[0].rows;
    assert.equal(rows[0].name, "new", "newer package must appear first");
    assert.equal(rows[1].name, "old");
  });
});

// ── Client-side rendering logic in the sort script ────────────────────────────

describe("generateReport — sort script rendering logic", () => {
  it("includes age-class assignment logic for recent release dates", () => {
    const html = generateReport(
      makeResults([{ name: "pkg", version: "1.0", releaseDate: "2023-01-01" }]),
      new Set(),
    );
    assert.ok(html.includes("age-new"), "script must reference age-new class");
    assert.ok(html.includes("age-orange"), "script must reference age-orange class");
    assert.ok(html.includes("age-fresh"), "script must reference age-fresh class");
  });

  it("includes supply chain score class thresholds", () => {
    const html = generateReport(
      makeResults([{ name: "pkg", version: "1.0", releaseDate: "2023-01-01" }]),
      new Set(),
      { socketScores: new Map() },
    );
    assert.ok(html.includes("score-good"), "script must reference score-good class");
    assert.ok(html.includes("score-warn"), "script must reference score-warn class");
    assert.ok(html.includes("score-bad"), "script must reference score-bad class");
  });

  it("uses encodeURIComponent to build socket.dev package links", () => {
    const html = generateReport(
      makeResults([{ name: "requests", version: "2.31.0", releaseDate: "2023-05-22" }]),
      new Set(),
      { socketScores: new Map() },
    );
    assert.ok(
      html.includes("encodeURIComponent"),
      "sort script must use encodeURIComponent for socket.dev links",
    );
  });

  it("validates the URL scheme before assigning to a.href", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(
      html.includes("https?:"),
      "sort script must validate URL scheme (https?:) before assigning href",
    );
  });

  it("uses textContent to set row cell text (no innerHTML with user data)", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(
      html.includes("textContent"),
      "sort script must use textContent for safe DOM text insertion",
    );
    assert.ok(
      !html.includes("innerHTML="),
      "sort script must not assign innerHTML (user data goes through textContent)",
    );
  });
});

// ── Sort UI (data-col attributes, script, nonce, CSP) ────────────────────────

describe("generateReport — sort UI", () => {
  it("adds data-col attribute to every column header", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    for (const col of ["name", "version", "released", "firstReleased", "releases"]) {
      assert.ok(html.includes(`data-col="${col}"`), `Expected data-col="${col}" on a <th>`);
    }
  });

  it("marks the Released header with th-sort-desc by default", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(
      html.includes('data-col="released"') && html.includes("th-sort-desc"),
      "Released column header must start with th-sort-desc class",
    );
  });

  it("embeds a <script> block", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("<script "), "must contain an inline script block");
  });

  it("uses a nonce on the script tag", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(
      /<script nonce="[A-Za-z0-9+/=]+"/.test(html),
      "script tag must have a nonce attribute",
    );
  });

  it("matches the nonce in the CSP meta tag and the script tag", () => {
    const html = generateReport(new Map(), new Set());
    const cspMatch = html.match(/script-src 'nonce-([^']+)'/);
    const scriptMatch = html.match(/<script nonce="([^"]+)"/);
    assert.ok(cspMatch, "CSP must contain script-src nonce");
    assert.ok(scriptMatch, "script tag must have nonce attribute");
    assert.equal(cspMatch[1], scriptMatch[1], "CSP nonce and script nonce must match");
  });

  it("embeds the row data as JSON in the script block", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes('"rows"'), "embedded JSON must contain a rows key");
  });
});

// ── XSS safety ───────────────────────────────────────────────────────────────

describe("generateReport — XSS safety", () => {
  it("unicode-escapes < and > in the embedded JSON so raw script tags cannot appear", () => {
    const results = makeResults([
      { name: "<script>alert(1)</script>", version: "1.0.0", releaseDate: "2023-01-01" },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(
      !html.includes("<script>alert"),
      "raw <script> tag must not appear anywhere in the output",
    );
    // JSON.stringify + unicode-escape replaces < and > with < / >
    assert.ok(
      html.includes("\\u003cscript\\u003e"),
      "angle brackets must be unicode-escaped in the embedded JSON",
    );
  });

  it("includes a Content-Security-Policy meta tag", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("Content-Security-Policy"), "CSP meta tag must be present");
    assert.ok(html.includes("default-src 'none'"), "CSP must block all sources by default");
  });

  it("escapes & in source filenames rendered inside the per-section summary", () => {
    const results = makeResults([
      { name: "requests", version: "2.31.0", releaseDate: "2023-05-22" },
    ]);
    const html = generateReport(results, new Set(), { ecosystem: "python", source: "a&b.json" });
    assert.ok(html.includes("a&amp;b.json"));
    assert.ok(!html.includes("a&b.json"));
  });

  it("does not place raw package names into HTML attributes or text", () => {
    const results = makeResults([
      {
        name: '"quoted"',
        version: "1.0.0",
        releaseDate: "2023-01-01",
        link: "https://pypi.org/project/quoted/",
      },
    ]);
    const html = generateReport(results, new Set());
    // The name must only appear inside JSON (as a JS string), never in raw HTML markup
    assert.ok(
      !html.includes('<td>"quoted"'),
      "raw package name must not appear as HTML text content",
    );
    assert.ok(!html.includes('>"quoted"<'), "raw package name must not appear between HTML tags");
  });
});

// ── Error rows ────────────────────────────────────────────────────────────────

describe("generateReport — error rows", () => {
  it("embeds the error flag in the row JSON so the client can render row-error", () => {
    const results = makeResults([
      { name: "broken", version: "error", releaseDate: "unknown", error: "Package not found" },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find((r) => r.name === "broken");
    assert.ok(row, "broken package must appear in rows");
    assert.ok(row.error, "error field must be truthy");
  });

  it("script source includes row-error class for client-side error rendering", () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes("row-error"), "sort script must reference row-error class");
  });
});

function ddRecord(overrides = {}) {
  return {
    versionFound: true,
    versionFindings: [],
    packageFindings: [],
    cooldownEnd: null,
    recommended: null,
    ...overrides,
  };
}

describe("generateReport — depsDevFindings", () => {
  const results = makeResults([
    { name: "lodahs", version: "1.0.0", releaseDate: "2024-01-05" },
    { name: "ua-parser-js", version: "0.7.29", releaseDate: "2024-01-04" },
    { name: "django", version: "3.2.0", releaseDate: "2024-01-03" },
    { name: "left-pad", version: "1.3.0", releaseDate: "2024-01-02" },
    { name: "requests", version: "2.31.0", releaseDate: "2024-01-01" },
    { name: "nofindings", version: "1.0.0", releaseDate: "2023-12-31" },
  ]);
  const findings = new Map([
    [
      "pypi:lodahs@1.0.0",
      ddRecord({
        versionFindings: [{ type: "NOT_FOUND" }],
        packageFindings: [{ type: "MALICIOUS" }],
      }),
    ],
    ["pypi:ua-parser-js@0.7.29", ddRecord({ versionFindings: [{ type: "NOT_FOUND" }] })],
    [
      "pypi:django@3.2.0",
      ddRecord({
        versionFindings: [{ type: "VULNERABLE" }],
        recommended: { version: "4.2.0", types: ["REMEDIATION"] },
      }),
    ],
    ["pypi:left-pad@1.3.0", ddRecord({ packageFindings: [{ type: "DEPRECATED" }] })],
    ["pypi:requests@2.31.0", ddRecord()],
  ]);

  function rowsOf(html) {
    return extractScriptData(html).sections[0].rows;
  }

  describe("column header", () => {
    it("adds a deps.dev header sorting by depsDevSeverity", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: findings });
      assert.ok(html.includes('<th data-col="depsDevSeverity" class="th-sort-desc">deps.dev</th>'));
    });

    it("makes deps.dev severity the default sort (header marker + initial script state)", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: findings });
      assert.ok(html.includes('<th data-col="released">Released</th>'));
      assert.ok(html.includes("col:s.showDepsDev?'depsDevSeverity':'released'"));
    });

    it("keeps release date as the default sort without depsDevFindings", () => {
      const html = generateReport(results, new Set());
      assert.ok(html.includes('<th data-col="released" class="th-sort-desc">Released</th>'));
    });

    it("omits the deps.dev header when depsDevFindings is not given", () => {
      const html = generateReport(results, new Set());
      assert.ok(!html.includes('data-col="depsDevSeverity"'));
    });

    it("adds the header even when the findings Map is empty", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: new Map() });
      assert.ok(html.includes('data-col="depsDevSeverity"'));
    });
  });

  describe("banner", () => {
    it("renders malicious and pulled banners as note-danger alerts", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: findings });
      assert.ok(
        html.includes(
          '<p class="note-danger" role="alert">⚠ 1 package is flagged as malicious: lodahs@1.0.0. Do not install it — remove it from your dependencies.</p>',
        ),
      );
      assert.ok(
        html.includes(
          '<p class="note-danger" role="alert">⚠ 1 locked version was pulled from the registry (often after a compromise): ua-parser-js@0.7.29. Upgrade or remove it.</p>',
        ),
      );
    });

    it("places the banner before the table", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: findings });
      assert.ok(html.indexOf('role="alert"') < html.indexOf('<div class="table-scroll">'));
    });

    it("renders no banner when nothing is malicious or pulled", () => {
      const html = generateReport(results, new Set(), {
        depsDevFindings: new Map([["pypi:requests@2.31.0", ddRecord()]]),
      });
      assert.ok(!html.includes('<p class="note-danger"'));
    });

    it("renders no banner when depsDevFindings is not given", () => {
      const html = generateReport(results, new Set());
      assert.ok(!html.includes('<p class="note-danger"'));
    });

    it("HTML-escapes a package name containing a script tag in the banner", () => {
      const evil = makeResults([
        { name: "<script>alert(1)</script>", version: "1.0.0", releaseDate: "2024-01-01" },
      ]);
      const html = generateReport(evil, new Set(), {
        depsDevFindings: new Map([
          [
            "pypi:<script>alert(1)</script>@1.0.0",
            ddRecord({ packageFindings: [{ type: "MALICIOUS" }] }),
          ],
        ]),
      });
      assert.ok(html.includes('<p class="note-danger" role="alert">'));
      assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;@1.0.0"));
      assert.ok(!html.includes("<script>alert"));
    });

    it("HTML-escapes quotes and ampersands in the banner", () => {
      const evil = makeResults([{ name: `a"b'&c`, version: "1.0.0", releaseDate: "2024-01-01" }]);
      const html = generateReport(evil, new Set(), {
        depsDevFindings: new Map([
          [`pypi:a"b'&c@1.0.0`, ddRecord({ versionFindings: [{ type: "NOT_FOUND" }] })],
        ]),
      });
      assert.ok(html.includes("a&quot;b&#x27;&amp;c@1.0.0"));
    });
  });

  describe("embedded row fields", () => {
    it("embeds text, class, tooltip, URL and severity for a malicious row", () => {
      const row = rowsOf(generateReport(results, new Set(), { depsDevFindings: findings })).find(
        (r) => r.name === "lodahs",
      );
      assert.equal(row.depsDevText, "malicious +1");
      assert.equal(row.depsDevClass, "score-bad");
      assert.equal(
        row.depsDevTitle,
        "Flagged as malicious (OSSF Malicious Packages). Do not install.\nThis version is no longer in the registry — often removed after a compromise.",
      );
      assert.equal(row.depsDevUrl, "https://deps.dev/pypi/lodahs/1.0.0");
      assert.equal(row.depsDevSeverity, 7);
    });

    it("maps each colour band to its CSS class", () => {
      const rows = rowsOf(generateReport(results, new Set(), { depsDevFindings: findings }));
      const cls = Object.fromEntries(rows.map((r) => [r.name, r.depsDevClass]));
      assert.equal(cls["ua-parser-js"], "score-bad");
      assert.equal(cls.django, "age-orange");
      assert.equal(cls["left-pad"], "score-warn");
      assert.equal(cls.requests, "score-good");
    });

    it("includes the recommended upgrade in the tooltip", () => {
      const row = rowsOf(generateReport(results, new Set(), { depsDevFindings: findings })).find(
        (r) => r.name === "django",
      );
      assert.equal(
        row.depsDevTitle,
        "Affected by a critical vulnerability.\nRecommended: 4.2.0 (fixes a known vulnerability)",
      );
    });

    it("embeds an en dash and null link and severity for a row without a record", () => {
      const row = rowsOf(generateReport(results, new Set(), { depsDevFindings: findings })).find(
        (r) => r.name === "nofindings",
      );
      assert.equal(row.depsDevText, "–");
      assert.equal(row.depsDevClass, "");
      assert.equal(row.depsDevTitle, "");
      assert.equal(row.depsDevUrl, null);
      assert.equal(row.depsDevSeverity, null);
    });

    it("embeds no deps.dev fields when depsDevFindings is not given", () => {
      const rows = rowsOf(generateReport(results, new Set()));
      for (const r of rows) {
        for (const k of [
          "depsDevText",
          "depsDevClass",
          "depsDevTitle",
          "depsDevUrl",
          "depsDevSeverity",
        ]) {
          assert.ok(!(k in r), `${k} must be absent`);
        }
      }
    });

    it("percent-encodes a Go module path in the deps.dev URL", () => {
      const goResults = makeResults([
        { name: "github.com/gin-gonic/gin", version: "v1.9.1", releaseDate: "2024-01-01" },
      ]);
      const html = generateReport(goResults, new Set(), {
        ecosystem: "go",
        depsDevFindings: new Map([["golang:github.com/gin-gonic/gin@v1.9.1", ddRecord()]]),
      });
      assert.equal(
        rowsOf(html)[0].depsDevUrl,
        "https://deps.dev/go/github.com%2Fgin-gonic%2Fgin/v1.9.1",
      );
    });

    it("sorts depsDevSeverity numerically in the embedded sort script", () => {
      const html = generateReport(results, new Set(), { depsDevFindings: findings });
      assert.ok(html.includes("col==='depsDevSeverity'"));
    });
  });
});
