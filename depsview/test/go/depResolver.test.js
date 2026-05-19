import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDependencies } from '../../src/go/depResolver.js';

/**
 * Builds a minimal Response-shaped object for fetch mocking.
 * @param {number} status
 * @param {string} body
 */
function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe('go resolveDependencies', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('returns release metadata for a known module', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/@v/v1.9.1.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v1.9.1', Time: '2023-06-23T08:00:00Z' }));
      }
      if (url.endsWith('/@v/list')) {
        return mockResponse(200, 'v1.0.0\nv1.5.0\nv1.9.1\n');
      }
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([
      { name: 'github.com/gin-gonic/gin', version: 'v1.9.1' },
    ]);

    const key = 'github.com/gin-gonic/gin@v1.9.1';
    assert.equal(results.size, 1);
    const r = results.get(key);
    assert.equal(r.name, 'github.com/gin-gonic/gin');
    assert.equal(r.version, 'v1.9.1');
    assert.equal(r.releaseDate, '2023-06-23');
    assert.equal(r.releaseCount, 3);
    assert.equal(r.firstReleaseDate, 'unknown');
    assert.equal(r.downloadsLastMonth, null);
    assert.equal(r.link, 'https://pkg.go.dev/github.com/gin-gonic/gin@v1.9.1');
    assert.equal(r.error, undefined);
  });

  it('records an error entry when the module is not found', async () => {
    globalThis.fetch = async () => mockResponse(404, '');

    const results = await resolveDependencies([
      { name: 'example.com/missing', version: 'v0.0.1' },
    ]);

    const r = results.get('example.com/missing@v0.0.1');
    assert.equal(r.error, 'Module not found on proxy.golang.org');
    assert.equal(r.releaseDate, 'unknown');
    assert.equal(r.releaseCount, 0);
  });

  it('resolves multiple modules in a single call', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v1.0.0', Time: '2024-01-01T00:00:00Z' }));
      }
      if (url.endsWith('/@v/list')) {
        return mockResponse(200, 'v0.9.0\nv1.0.0\n');
      }
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([
      { name: 'golang.org/x/crypto',         version: 'v1.0.0' },
      { name: 'github.com/stretchr/testify', version: 'v1.0.0' },
    ]);
    assert.equal(results.size, 2);
  });

  it('uses the literal module path in the pkg.go.dev link (preserves case)', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('.info')) return mockResponse(200, JSON.stringify({ Time: '2023-01-01T00:00:00Z' }));
      if (url.endsWith('/@v/list')) return mockResponse(200, 'v1.3.2\n');
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([
      { name: 'github.com/BurntSushi/toml', version: 'v1.3.2' },
    ]);
    const r = results.get('github.com/burntsushi/toml@v1.3.2');
    assert.equal(r.link, 'https://pkg.go.dev/github.com/BurntSushi/toml@v1.3.2');
  });

  it('resolves transitive dependencies declared in a module go.mod', async () => {
    const ginMod = 'module github.com/gin-gonic/gin\n\ngo 1.21\n\nrequire golang.org/x/net v0.17.0\n';
    const netMod = 'module golang.org/x/net\n\ngo 1.21\n';

    globalThis.fetch = async (url) => {
      if (url.includes('gin-gonic/gin') && url.endsWith('.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v1.9.1', Time: '2023-06-23T08:00:00Z' }));
      }
      if (url.includes('gin-gonic/gin') && url.endsWith('/@v/list')) {
        return mockResponse(200, 'v1.9.1\n');
      }
      if (url.includes('gin-gonic/gin') && url.endsWith('.mod')) {
        return mockResponse(200, ginMod);
      }
      if (url.includes('golang.org/x/net') && url.endsWith('.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v0.17.0', Time: '2023-10-11T00:00:00Z' }));
      }
      if (url.includes('golang.org/x/net') && url.endsWith('/@v/list')) {
        return mockResponse(200, 'v0.17.0\n');
      }
      if (url.includes('golang.org/x/net') && url.endsWith('.mod')) {
        return mockResponse(200, netMod);
      }
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([
      { name: 'github.com/gin-gonic/gin', version: 'v1.9.1' },
    ]);

    assert.equal(results.size, 2);
    assert.ok(results.has('github.com/gin-gonic/gin@v1.9.1'));
    assert.ok(results.has('golang.org/x/net@v0.17.0'));
    assert.equal(results.get('golang.org/x/net@v0.17.0').releaseDate, '2023-10-11');
  });

  it('does not re-resolve a module that appears in multiple go.mod files (cycle guard)', async () => {
    const modA = 'module example.com/a\n\ngo 1.21\n\nrequire example.com/b v1.0.0\n';
    const modB = 'module example.com/b\n\ngo 1.21\n\nrequire example.com/a v1.0.0\n';
    let fetchCount = 0;

    globalThis.fetch = async (url) => {
      fetchCount++;
      if (url.includes('example.com/a') && url.endsWith('.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v1.0.0', Time: '2024-01-01T00:00:00Z' }));
      }
      if (url.includes('example.com/a') && url.endsWith('/@v/list')) {
        return mockResponse(200, 'v1.0.0\n');
      }
      if (url.includes('example.com/a') && url.endsWith('.mod')) {
        return mockResponse(200, modA);
      }
      if (url.includes('example.com/b') && url.endsWith('.info')) {
        return mockResponse(200, JSON.stringify({ Version: 'v1.0.0', Time: '2024-01-01T00:00:00Z' }));
      }
      if (url.includes('example.com/b') && url.endsWith('/@v/list')) {
        return mockResponse(200, 'v1.0.0\n');
      }
      if (url.includes('example.com/b') && url.endsWith('.mod')) {
        return mockResponse(200, modB);
      }
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([{ name: 'example.com/a', version: 'v1.0.0' }]);

    assert.equal(results.size, 2);
    assert.ok(results.has('example.com/a@v1.0.0'));
    assert.ok(results.has('example.com/b@v1.0.0'));
    assert.ok(fetchCount <= 6, `expected at most 6 fetches (3 per module), got ${fetchCount}`);
  });

  it('resolves a package path to its containing module root when the full path returns 404', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('golang.org/x/lint/golint')) {
        return mockResponse(404, '');
      }
      if (url.includes('golang.org/x/lint') && (url.endsWith('/@latest') || url.endsWith('.info'))) {
        return mockResponse(200, JSON.stringify({ Version: 'v0.0.0-20210508222113-6edffad5e616', Time: '2021-05-08T00:00:00Z' }));
      }
      if (url.includes('golang.org/x/lint') && url.endsWith('/@v/list')) {
        return mockResponse(200, 'v0.0.0-20210508222113-6edffad5e616\n');
      }
      return mockResponse(404, '');
    };

    const results = await resolveDependencies([
      { name: 'golang.org/x/lint/golint', version: 'latest' },
    ]);

    assert.equal(results.size, 1);
    assert.ok(results.has('golang.org/x/lint@v0.0.0-20210508222113-6edffad5e616'));
    const r = results.get('golang.org/x/lint@v0.0.0-20210508222113-6edffad5e616');
    assert.equal(r.name, 'golang.org/x/lint');
    assert.equal(r.error, undefined);
  });

  it('records an error when no parent path resolves either', async () => {
    globalThis.fetch = async () => mockResponse(404, '');

    const results = await resolveDependencies([
      { name: 'example.com/totally/unknown/pkg', version: 'latest' },
    ]);

    assert.equal(results.size, 1);
    const r = [...results.values()][0];
    assert.ok(r.error);
  });
});
