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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateReport as generateReportRaw } from '../../src/output/reportGenerator.js';

/**
 * Builds a results Map in the same shape that depResolver produces.
 * @param {Array<object>} items
 * @returns {Map<string, object>}
 */
function makeResults(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.name.toLowerCase(), {
      name:             item.name,
      version:          item.version,
      releaseDate:      item.releaseDate      ?? 'unknown',
      firstReleaseDate: item.firstReleaseDate ?? 'unknown',
      releaseCount:     item.releaseCount     ?? 0,
      downloadsLastMonth: item.downloadsLastMonth ?? null,
      link:             item.link ?? `https://pypi.org/project/${item.name}/`,
      error:            item.error,
    });
  }
  return map;
}

/**
 * Test shim that wraps a single (results, directNames) pair into the
 * sections Map that the production `generateReport` now expects.
 */
function generateReport(results, directNames = new Set(), opts = {}) {
  const ecosystem = opts.ecosystem ?? 'python';
  const source    = opts.source    ?? null;
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
  const start = html.indexOf('var D=') + 6;
  assert.ok(start > 5, 'Could not find embedded script data (var D=) in HTML');
  const end = html.indexOf(';\nvar state=', start);
  assert.ok(end > start, 'Could not find end of embedded script data in HTML');
  return JSON.parse(html.slice(start, end));
}

// ── HTML structure ─────────────────────────────────────────────────────────────

describe('generateReport — HTML structure', () => {
  it('returns a complete HTML document', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with DOCTYPE');
    assert.ok(html.includes('</html>'), 'must end with closing html tag');
  });

  it('sets the page title to "Dependency Report"', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('<title>Dependency Report</title>'));
  });

  it('embeds a <style> block (self-contained, no external CSS)', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('<style>'), 'must embed inline styles');
    assert.ok(!html.includes('<link rel="stylesheet"'), 'must not reference external CSS');
  });

  it('renders the "Dependency Report" heading', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('Dependency Report'));
  });

  it('emits an empty <tbody> — rows are rendered client-side', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes('<tbody></tbody>'), '<tbody> must be empty in the static HTML');
  });
});

// ── Meta line ──────────────────────────────────────────────────────────────────

describe('generateReport — meta line', () => {
  it('includes the ecosystem label when provided', () => {
    const html = generateReport(new Map(), new Set(), { ecosystem: 'npm' });
    assert.ok(html.includes('npm'));
  });

  it('includes the source file name when provided', () => {
    const html = generateReport(new Map(), new Set(), { source: 'package-lock.json' });
    assert.ok(html.includes('package-lock.json'));
  });

  it('includes a UTC timestamp', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('UTC'));
  });
});

// ── Summary line ───────────────────────────────────────────────────────────────

describe('generateReport — summary line', () => {
  it('shows "0 packages total" for an empty map', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('0 packages total'));
  });

  it('shows correct total count', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
      { name: 'certifi',  version: '2024.1', releaseDate: '2024-01-01' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes('2 packages total'));
  });

  it('shows direct and transitive breakdown when directNames is non-empty', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
      { name: 'urllib3',  version: '2.0.0',  releaseDate: '2023-03-10' },
    ]);
    const directNames = new Set(['requests']);
    const html = generateReport(results, directNames);
    assert.ok(html.includes('1 direct'));
    assert.ok(html.includes('1 transitive'));
  });

  it('omits the direct/transitive breakdown when directNames is empty', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(!html.includes('direct'), 'must not mention "direct" when directNames is empty');
  });
});

// ── Table columns ─────────────────────────────────────────────────────────────

describe('generateReport — table columns', () => {
  it('renders all default column headers', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    for (const header of ['Package', 'Version', 'Released', 'First Release', 'Releases', 'Downloads/mo']) {
      assert.ok(html.includes(header), `Expected column header "${header}"`);
    }
    assert.ok(!html.includes('<th>Link</th>'), 'Link column must not appear (name already links)');
  });

  it('omits the Downloads/mo column when downloadStats is false', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set(), { downloadStats: false });
    assert.ok(!html.includes('Downloads/mo'), 'Downloads/mo column must be absent');
  });

  it('adds the Supply Chain column when socketScores is provided', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set(), { socketScores: new Map() });
    assert.ok(html.includes('Supply Chain'), 'Supply Chain column must appear');
  });

  it('omits the Supply Chain column when socketScores is not provided', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(!html.includes('Supply Chain'), 'Supply Chain column must not appear without socketScores');
  });
});

// ── Embedded script JSON ───────────────────────────────────────────────────────

describe('generateReport — embedded script JSON', () => {
  it('embeds the package name in the rows array', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.ok(row, 'requests must be present in the embedded rows');
  });

  it('embeds the registry link in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22',
        link: 'https://pypi.org/project/requests/' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.equal(row.link, 'https://pypi.org/project/requests/');
  });

  it('embeds the version in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.equal(row.version, '2.31.0');
  });

  it('embeds the release date in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.equal(row.released, '2023-05-22');
  });

  it('embeds the first release date in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22',
        firstReleaseDate: '2011-02-14' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.equal(row.firstReleased, '2011-02-14');
  });

  it('embeds the release count in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22', releaseCount: 144 },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.equal(row.releases, 144);
  });

  it('embeds the supply chain score in the row', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const socketScores = new Map([['pypi:requests@2.31.0', 0.87]]);
    const data = extractScriptData(generateReport(results, new Set(), { socketScores }));
    const row = data.sections[0].rows.find(r => r.name === 'requests');
    assert.ok(Math.abs(row.supplyChain - 0.87) < 0.001);
  });

  it('embeds the socketSlug so the script can build socket.dev links', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set(), {
      socketScores: new Map([['pypi:requests@2.31.0', 0.87]]),
      ecosystem: 'python',
    });
    const data = extractScriptData(html);
    assert.equal(data.sections[0].socketSlug, 'pypi');
  });

  it('rows are ordered newest-first in the embedded JSON', () => {
    const results = makeResults([
      { name: 'old', version: '1.0.0', releaseDate: '2020-01-01' },
      { name: 'new', version: '2.0.0', releaseDate: '2024-06-01' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const rows = data.sections[0].rows;
    assert.equal(rows[0].name, 'new', 'newer package must appear first');
    assert.equal(rows[1].name, 'old');
  });
});

// ── Client-side rendering logic in the sort script ────────────────────────────

describe('generateReport — sort script rendering logic', () => {
  it('includes age-class assignment logic for recent release dates', () => {
    const html = generateReport(
      makeResults([{ name: 'pkg', version: '1.0', releaseDate: '2023-01-01' }]),
      new Set(),
    );
    assert.ok(html.includes('age-new'),    'script must reference age-new class');
    assert.ok(html.includes('age-orange'), 'script must reference age-orange class');
    assert.ok(html.includes('age-fresh'),  'script must reference age-fresh class');
  });

  it('includes supply chain score class thresholds', () => {
    const html = generateReport(
      makeResults([{ name: 'pkg', version: '1.0', releaseDate: '2023-01-01' }]),
      new Set(),
      { socketScores: new Map() },
    );
    assert.ok(html.includes('score-good'), 'script must reference score-good class');
    assert.ok(html.includes('score-warn'), 'script must reference score-warn class');
    assert.ok(html.includes('score-bad'),  'script must reference score-bad class');
  });

  it('uses encodeURIComponent to build socket.dev package links', () => {
    const html = generateReport(
      makeResults([{ name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' }]),
      new Set(),
      { socketScores: new Map() },
    );
    assert.ok(html.includes('encodeURIComponent'),
      'sort script must use encodeURIComponent for socket.dev links');
  });

  it('validates the URL scheme before assigning to a.href', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('https?:'),
      'sort script must validate URL scheme (https?:) before assigning href');
  });

  it('uses textContent to set row cell text (no innerHTML with user data)', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('textContent'),
      'sort script must use textContent for safe DOM text insertion');
    assert.ok(!html.includes('innerHTML='),
      'sort script must not assign innerHTML (user data goes through textContent)');
  });
});

// ── Sort UI (data-col attributes, script, nonce, CSP) ────────────────────────

describe('generateReport — sort UI', () => {
  it('adds data-col attribute to every column header', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    for (const col of ['name', 'version', 'released', 'firstReleased', 'releases']) {
      assert.ok(html.includes(`data-col="${col}"`), `Expected data-col="${col}" on a <th>`);
    }
  });

  it('marks the Released header with th-sort-desc by default', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(
      html.includes('data-col="released"') && html.includes('th-sort-desc'),
      'Released column header must start with th-sort-desc class'
    );
  });

  it('embeds a <script> block', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('<script '), 'must contain an inline script block');
  });

  it('uses a nonce on the script tag', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(/<script nonce="[A-Za-z0-9+/=]+"/.test(html), 'script tag must have a nonce attribute');
  });

  it('matches the nonce in the CSP meta tag and the script tag', () => {
    const html = generateReport(new Map(), new Set());
    const cspMatch    = html.match(/script-src 'nonce-([^']+)'/);
    const scriptMatch = html.match(/<script nonce="([^"]+)"/);
    assert.ok(cspMatch, 'CSP must contain script-src nonce');
    assert.ok(scriptMatch, 'script tag must have nonce attribute');
    assert.equal(cspMatch[1], scriptMatch[1], 'CSP nonce and script nonce must match');
  });

  it('embeds the row data as JSON in the script block', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(html.includes('"rows"'), 'embedded JSON must contain a rows key');
  });
});

// ── XSS safety ───────────────────────────────────────────────────────────────

describe('generateReport — XSS safety', () => {
  it('unicode-escapes < and > in the embedded JSON so raw script tags cannot appear', () => {
    const results = makeResults([
      { name: '<script>alert(1)</script>', version: '1.0.0', releaseDate: '2023-01-01' },
    ]);
    const html = generateReport(results, new Set());
    assert.ok(!html.includes('<script>alert'),
      'raw <script> tag must not appear anywhere in the output');
    // JSON.stringify + unicode-escape replaces < and > with < / >
    assert.ok(html.includes('\\u003cscript\\u003e'),
      'angle brackets must be unicode-escaped in the embedded JSON');
  });

  it('includes a Content-Security-Policy meta tag', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('Content-Security-Policy'), 'CSP meta tag must be present');
    assert.ok(html.includes("default-src 'none'"), 'CSP must block all sources by default');
  });

  it('escapes & in source filenames rendered inside the per-section summary', () => {
    const results = makeResults([
      { name: 'requests', version: '2.31.0', releaseDate: '2023-05-22' },
    ]);
    const html = generateReport(results, new Set(), { ecosystem: 'python', source: 'a&b.json' });
    assert.ok(html.includes('a&amp;b.json'));
    assert.ok(!html.includes('a&b.json'));
  });

  it('does not place raw package names into HTML attributes or text', () => {
    const results = makeResults([
      { name: '"quoted"', version: '1.0.0', releaseDate: '2023-01-01',
        link: 'https://pypi.org/project/quoted/' },
    ]);
    const html = generateReport(results, new Set());
    // The name must only appear inside JSON (as a JS string), never in raw HTML markup
    assert.ok(!html.includes('<td>"quoted"'),
      'raw package name must not appear as HTML text content');
    assert.ok(!html.includes('>"quoted"<'),
      'raw package name must not appear between HTML tags');
  });
});

// ── Error rows ────────────────────────────────────────────────────────────────

describe('generateReport — error rows', () => {
  it('embeds the error flag in the row JSON so the client can render row-error', () => {
    const results = makeResults([
      { name: 'broken', version: 'error', releaseDate: 'unknown', error: 'Package not found' },
    ]);
    const data = extractScriptData(generateReport(results, new Set()));
    const row = data.sections[0].rows.find(r => r.name === 'broken');
    assert.ok(row, 'broken package must appear in rows');
    assert.ok(row.error, 'error field must be truthy');
  });

  it('script source includes row-error class for client-side error rendering', () => {
    const html = generateReport(new Map(), new Set());
    assert.ok(html.includes('row-error'), 'sort script must reference row-error class');
  });
});
