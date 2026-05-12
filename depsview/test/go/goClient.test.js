import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeModulePath, getReleaseDate } from '../../src/go/goClient.js';

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
