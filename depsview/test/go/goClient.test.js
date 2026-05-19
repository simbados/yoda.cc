import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { escapeModulePath, getReleaseDate, fetchModuleMod } from '../../src/go/goClient.js';

// ── escapeModulePath ──────────────────────────────────────────────────────────

describe('escapeModulePath', () => {
  it('encodes uppercase letters as !lowercase per the GOPROXY protocol', () => {
    assert.equal(
      escapeModulePath('github.com/BurntSushi/toml'),
      'github.com/!burnt!sushi/toml'
    );
  });

  it('leaves all-lowercase paths unchanged', () => {
    assert.equal(
      escapeModulePath('github.com/gin-gonic/gin'),
      'github.com/gin-gonic/gin'
    );
  });

  it('escapes multiple uppercase letters in sequence', () => {
    assert.equal(escapeModulePath('example.com/ABC'), 'example.com/!a!b!c');
  });

  it('preserves dots, slashes, hyphens, and digits', () => {
    assert.equal(
      escapeModulePath('gopkg.in/yaml.v3'),
      'gopkg.in/yaml.v3'
    );
  });
});

// ── fetchModuleMod ───────────────────────────────────────────────────────────

describe('fetchModuleMod', () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('returns raw go.mod text on a successful response', async () => {
    const modContent = 'module example.com/foo\n\ngo 1.21\n\nrequire github.com/bar/baz v1.0.0\n';
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => modContent,
    });
    const result = await fetchModuleMod('example.com/foo', 'v1.0.0');
    assert.equal(result, modContent);
  });

  it('returns null on a 404 response', async () => {
    globalThis.fetch = async () => ({
      status: 404,
      ok: false,
      headers: { get: () => null },
      text: async () => '',
    });
    const result = await fetchModuleMod('example.com/missing', 'v1.0.0');
    assert.equal(result, null);
  });

  it('applies GOPROXY path escaping to uppercase letters in the module name', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    await fetchModuleMod('github.com/BurntSushi/toml', 'v1.3.2');
    assert.ok(capturedUrl.includes('!burnt!sushi'), `expected escaped path, got: ${capturedUrl}`);
  });

  it('appends .mod to the version in the URL', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    await fetchModuleMod('example.com/pkg', 'v2.3.4');
    assert.ok(capturedUrl.endsWith('v2.3.4.mod'), `expected URL to end with v2.3.4.mod, got: ${capturedUrl}`);
  });

  it('returns null without fetching when the module name contains a query character', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' }; };
    const result = await fetchModuleMod('example.com/pkg?evil=1', 'v1.0.0');
    assert.equal(result, null);
    assert.equal(fetched, false);
  });

  it('returns null without fetching when the module name contains a fragment character', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' }; };
    const result = await fetchModuleMod('example.com/pkg#anchor', 'v1.0.0');
    assert.equal(result, null);
    assert.equal(fetched, false);
  });
});

// ── getReleaseDate ────────────────────────────────────────────────────────────

describe('getReleaseDate', () => {
  it('truncates an ISO timestamp to YYYY-MM-DD', () => {
    assert.equal(getReleaseDate({ Time: '2023-06-23T08:00:00Z' }), '2023-06-23');
  });

  it('returns "unknown" when info is null', () => {
    assert.equal(getReleaseDate(null), 'unknown');
  });

  it('returns "unknown" when Time is missing', () => {
    assert.equal(getReleaseDate({ Version: 'v1.0.0' }), 'unknown');
  });
});
