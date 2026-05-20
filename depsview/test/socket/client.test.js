import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSocketScores, buildPurl, parsePurl, parseNdjson, scoreKey } from '../../src/socket/client.js';

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

/** Returns a fetch mock that responds with the given NDJSON text. */
function mockNdjson(lines) {
  const text = lines.join('\n');
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => { throw new Error('should not call json()'); },
  });
}

/** Returns a fetch mock that responds with a non-ok status. */
function mockError(status) {
  globalThis.fetch = async () => ({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => '',
  });
}

// ── buildPurl ──────────────────────────────────────────────────────────────────

describe('buildPurl', () => {
  it('builds an npm purl', () => {
    assert.equal(buildPurl('express', '4.19.2', 'npm'), 'pkg:npm/express@4.19.2');
  });

  it('builds a pypi purl', () => {
    assert.equal(buildPurl('requests', '2.28.0', 'pypi'), 'pkg:pypi/requests@2.28.0');
  });

  it('builds a golang purl', () => {
    assert.equal(
      buildPurl('github.com/gin-gonic/gin', 'v1.9.1', 'golang'),
      'pkg:golang/github.com/gin-gonic/gin@v1.9.1'
    );
  });

  it('uses a raw @ for scoped npm packages — the socket.dev API expects it unencoded', () => {
    assert.equal(buildPurl('@clack/core', '1.3.0', 'npm'), 'pkg:npm/@clack/core@1.3.0');
  });
});

// ── parsePurl ──────────────────────────────────────────────────────────────────

describe('parsePurl', () => {
  it('parses a simple npm purl', () => {
    assert.deepEqual(parsePurl('pkg:npm/lodash@4.17.21'),
      { type: 'npm', name: 'lodash', version: '4.17.21' });
  });

  it('parses a scoped npm purl', () => {
    assert.deepEqual(parsePurl('pkg:npm/@clack/core@1.3.0'),
      { type: 'npm', name: '@clack/core', version: '1.3.0' });
  });

  it('parses a hierarchical golang purl', () => {
    assert.deepEqual(parsePurl('pkg:golang/github.com/gin-gonic/gin@v1.9.1'),
      { type: 'golang', name: 'github.com/gin-gonic/gin', version: 'v1.9.1' });
  });

  it('returns null for non-purl strings', () => {
    assert.equal(parsePurl('not-a-purl'), null);
    assert.equal(parsePurl(null), null);
    assert.equal(parsePurl(''), null);
    assert.equal(parsePurl('pkg:npm/no-version'), null);
  });
});

// ── parseNdjson ────────────────────────────────────────────────────────────────

describe('parseNdjson', () => {
  it('parses multiple lines', () => {
    const result = parseNdjson('{"a":1}\n{"b":2}');
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it('skips empty lines', () => {
    const result = parseNdjson('\n{"a":1}\n\n');
    assert.deepEqual(result, [{ a: 1 }]);
  });

  it('skips malformed lines without throwing', () => {
    const result = parseNdjson('{"a":1}\nnot-json\n{"b":2}');
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseNdjson(''), []);
  });
});

// ── scoreKey ──────────────────────────────────────────────────────────────────

describe('scoreKey', () => {
  it('builds ecosystem-tagged keys with lowercased name', () => {
    assert.equal(scoreKey('npm', 'Express', '4.19.2'), 'npm:express@4.19.2');
    assert.equal(scoreKey('pypi', 'Requests', '2.28.0'), 'pypi:requests@2.28.0');
    assert.equal(scoreKey('golang', 'github.com/BurntSushi/toml', 'v1.3.2'), 'golang:github.com/burntsushi/toml@v1.3.2');
  });
});

// ── fetchSocketScores ──────────────────────────────────────────────────────────

describe('fetchSocketScores — empty input', () => {
  it('returns an empty Map without making a network request', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; };
    const result = await fetchSocketScores([], 'key', 'org');
    assert.equal(called, false);
    assert.equal(result.size, 0);
  });
});

describe('fetchSocketScores — mixed ecosystems', () => {
  it('sends one batched request with per-item PURL types', async () => {
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => [
          JSON.stringify({ purl: 'pkg:npm/express@4.19.2',                       score: { supplyChain: 0.9 } }),
          JSON.stringify({ purl: 'pkg:pypi/requests@2.28.0',                     score: { supplyChain: 0.85 } }),
          JSON.stringify({ purl: 'pkg:golang/github.com/gin-gonic/gin@v1.9.1',  score: { supplyChain: 0.7 } }),
        ].join('\n'),
      };
    };

    const result = await fetchSocketScores(
      [
        { name: 'express',                  version: '4.19.2',  ecosystem: 'npm' },
        { name: 'requests',                 version: '2.28.0',  ecosystem: 'pypi' },
        { name: 'github.com/gin-gonic/gin', version: 'v1.9.1',  ecosystem: 'golang' },
      ],
      'key', 'org'
    );

    assert.deepEqual(capturedBody.components.map(c => c.purl), [
      'pkg:npm/express@4.19.2',
      'pkg:pypi/requests@2.28.0',
      'pkg:golang/github.com/gin-gonic/gin@v1.9.1',
    ]);
    assert.equal(result.size, 3);
    assert.equal(result.get('npm:express@4.19.2'),                       0.9);
    assert.equal(result.get('pypi:requests@2.28.0'),                     0.85);
    assert.equal(result.get('golang:github.com/gin-gonic/gin@v1.9.1'),  0.7);
  });

  it('uses echoed purl field when present in response', async () => {
    mockNdjson([
      JSON.stringify({ purl: 'pkg:npm/eslint@8.57.0', score: { supplyChain: 0.9 } }),
    ]);
    const result = await fetchSocketScores(
      [{ name: 'eslint', version: '8.57.0', ecosystem: 'npm' }],
      'key', 'org'
    );
    assert.equal(result.get('npm:eslint@8.57.0'), 0.9);
  });

  it('falls back to type/namespace/name fields when purl is absent', async () => {
    mockNdjson([
      JSON.stringify({ type: 'npm', namespace: '@clack', name: 'core', version: '1.3.0', score: { supplyChain: 1.0 } }),
    ]);
    const result = await fetchSocketScores(
      [{ name: '@clack/core', version: '1.3.0', ecosystem: 'npm' }],
      'key', 'org'
    );
    assert.equal(result.get('npm:@clack/core@1.3.0'), 1.0);
  });
});

describe('fetchSocketScores — authorization header', () => {
  it('sends Bearer token authorization', async () => {
    let capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => '',
      };
    };
    await fetchSocketScores([{ name: 'express', version: '4.19.2', ecosystem: 'npm' }], 'my-api-key', 'org');
    assert.equal(capturedHeaders['Authorization'], 'Bearer my-api-key');
  });
});

describe('fetchSocketScores — HTTP error', () => {
  it('returns an empty Map on 401', async () => {
    mockError(401);
    const result = await fetchSocketScores([{ name: 'express', version: '4.19.2', ecosystem: 'npm' }], 'bad-key', 'org');
    assert.equal(result.size, 0);
  });

  it('returns an empty Map on 500', async () => {
    mockError(500);
    const result = await fetchSocketScores([{ name: 'express', version: '4.19.2', ecosystem: 'npm' }], 'key', 'org');
    assert.equal(result.size, 0);
  });
});

describe('fetchSocketScores — missing score fields', () => {
  it('skips entries without score.supplyChain', async () => {
    mockNdjson([
      JSON.stringify({ purl: 'pkg:npm/lodash@4.17.21', score: {} }),
      JSON.stringify({ purl: 'pkg:npm/vite@5.1.0' }),
      JSON.stringify({ purl: 'pkg:npm/eslint@8.57.0', score: { supplyChain: 0.6 } }),
    ]);
    const result = await fetchSocketScores(
      [
        { name: 'lodash', version: '4.17.21', ecosystem: 'npm' },
        { name: 'vite',   version: '5.1.0',   ecosystem: 'npm' },
        { name: 'eslint', version: '8.57.0',  ecosystem: 'npm' },
      ],
      'key', 'org'
    );
    assert.equal(result.size, 1);
    assert.equal(result.get('npm:eslint@8.57.0'), 0.6);
  });
});

describe('fetchSocketScores — network error', () => {
  it('returns an empty Map when fetch throws', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await fetchSocketScores([{ name: 'express', version: '4.19.2', ecosystem: 'npm' }], 'key', 'org');
    assert.equal(result.size, 0);
  });
});

describe('fetchSocketScores — name lowercasing', () => {
  it('lowercases the name in the map key', async () => {
    mockNdjson([
      JSON.stringify({ purl: 'pkg:npm/Vite@5.1.0', score: { supplyChain: 0.7 } }),
    ]);
    const result = await fetchSocketScores([{ name: 'Vite', version: '5.1.0', ecosystem: 'npm' }], 'key', 'org');
    assert.ok(result.has('npm:vite@5.1.0'));
  });
});

// ── fetchSocketScores — opts.proxyBase ─────────────────────────────────────────

describe('fetchSocketScores — opts.proxyBase', () => {
  it('uses proxyBase instead of the default socket.dev API base when provided', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ purl: 'pkg:npm/express@4.19.2', score: { supplyChain: 0.9 } }),
      };
    };

    await fetchSocketScores(
      [{ name: 'express', version: '4.19.2', ecosystem: 'npm' }],
      'key',
      'my-org',
      { proxyBase: 'https://socket-proxy.example.workers.dev' }
    );

    assert.ok(
      capturedUrl.startsWith('https://socket-proxy.example.workers.dev/my-org/purl'),
      `Expected URL to start with proxy base + org slug, got: ${capturedUrl}`
    );
    assert.ok(
      !capturedUrl.includes('api.socket.dev'),
      'Default socket.dev base must not appear when proxyBase is set'
    );
  });

  it('still appends the orgSlug after proxyBase', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => '',
      };
    };

    await fetchSocketScores(
      [{ name: 'lodash', version: '4.17.21', ecosystem: 'npm' }],
      'key',
      'acme-corp',
      { proxyBase: 'https://proxy.example.com' }
    );

    assert.ok(
      capturedUrl.startsWith('https://proxy.example.com/acme-corp/purl'),
      `Expected URL to contain org slug after proxy base, got: ${capturedUrl}`
    );
  });

  it('uses the default socket.dev URL when opts is omitted', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => '',
      };
    };

    await fetchSocketScores(
      [{ name: 'express', version: '4.19.2', ecosystem: 'npm' }],
      'key',
      'my-org'
    );

    assert.ok(
      capturedUrl.startsWith('https://api.socket.dev/v0/orgs/my-org/purl'),
      `Expected default socket.dev URL, got: ${capturedUrl}`
    );
  });

  it('uses the default socket.dev URL when proxyBase is absent from opts', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => '',
      };
    };

    await fetchSocketScores(
      [{ name: 'express', version: '4.19.2', ecosystem: 'npm' }],
      'key',
      'my-org',
      {}
    );

    assert.ok(
      capturedUrl.startsWith('https://api.socket.dev/v0/orgs/my-org/purl'),
      `Expected default socket.dev URL when opts has no proxyBase, got: ${capturedUrl}`
    );
  });
});
