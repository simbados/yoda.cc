/**
 * Tests for src/go/depResolver.js.
 * Mocks globalThis.fetch to simulate proxy.golang.org responses.
 */

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
});
