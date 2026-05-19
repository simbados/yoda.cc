import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGoSum,
  parseGoMod,
  normalizeGoModulePath,
} from '../../src/go/parserCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// ── normalizeGoModulePath ─────────────────────────────────────────────────────

describe('normalizeGoModulePath', () => {
  it('lowercases module paths', () => {
    assert.equal(normalizeGoModulePath('github.com/BurntSushi/toml'), 'github.com/burntsushi/toml');
  });

  it('preserves dots, slashes, and hyphens', () => {
    assert.equal(normalizeGoModulePath('golang.org/x/crypto'), 'golang.org/x/crypto');
    assert.equal(normalizeGoModulePath('github.com/gin-gonic/gin'), 'github.com/gin-gonic/gin');
  });
});

// ── parseGoSum ────────────────────────────────────────────────────────────────

describe('parseGoSum', () => {
  it('parses a go.sum file and returns module + version entries', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'go-sum', 'go.sum'), 'utf8');
    const deps = parseGoSum(content);
    assert.deepEqual(deps, [
      { name: 'github.com/gin-gonic/gin',    version: 'v1.9.1' },
      { name: 'github.com/stretchr/testify', version: 'v1.8.4' },
      { name: 'golang.org/x/crypto',         version: 'v0.21.0' },
    ]);
  });

  it('excludes /go.mod-suffixed entries', () => {
    const content =
      'golang.org/x/crypto v0.21.0 h1:hash1=\n' +
      'golang.org/x/crypto v0.21.0/go.mod h1:hash2=\n';
    const deps = parseGoSum(content);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].version, 'v0.21.0');
  });

  it('deduplicates repeated entries', () => {
    const content =
      'golang.org/x/crypto v0.21.0 h1:hash1=\n' +
      'golang.org/x/crypto v0.21.0 h1:hash1=\n';
    assert.equal(parseGoSum(content).length, 1);
  });

  it('skips blank and malformed lines', () => {
    const content = '\n\nthisisnotvalid\ngolang.org/x/crypto v0.21.0 h1:hash=\n  \n';
    const deps = parseGoSum(content);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].name, 'golang.org/x/crypto');
  });

  it('handles pseudo-versions', () => {
    const content =
      'golang.org/x/sys v0.0.0-20210921155107-089bfa567519 h1:hash=\n';
    const deps = parseGoSum(content);
    assert.equal(deps[0].version, 'v0.0.0-20210921155107-089bfa567519');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseGoSum(''), []);
  });
});

// ── parseGoMod ────────────────────────────────────────────────────────────────

describe('parseGoMod', () => {
  const fixture = fs.readFileSync(path.join(FIXTURES, 'go-mod', 'go.mod'), 'utf8');

  it('returns exactly the require entries — ignoring module, go, toolchain, replace, exclude, retract', () => {
    const deps = parseGoMod(fixture);
    const summary = deps.map(d => `${d.name}@${d.version}${d.indirect ? ' (indirect)' : ''}`).sort();
    assert.deepEqual(summary, [
      'github.com/gin-gonic/gin@v1.9.1',
      'github.com/stretchr/testify@v1.8.4',
      'golang.org/x/crypto@v0.21.0 (indirect)',
    ]);
  });

  it('handles a single-line require without a block', () => {
    const content = 'module example.com/x\n\nrequire golang.org/x/crypto v0.21.0\n';
    const deps = parseGoMod(content);
    assert.equal(deps.length, 1);
    assert.deepEqual(deps[0], { name: 'golang.org/x/crypto', version: 'v0.21.0', indirect: false });
  });

  it('handles a require block with no entries', () => {
    const content = 'module example.com/x\n\nrequire (\n)\n';
    assert.deepEqual(parseGoMod(content), []);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseGoMod(''), []);
  });

  it('handles pseudo-versions', () => {
    const content =
      'module example.com/x\n\nrequire golang.org/x/sys v0.0.0-20210921155107-089bfa567519\n';
    const deps = parseGoMod(content);
    assert.equal(deps[0].version, 'v0.0.0-20210921155107-089bfa567519');
  });

  it('strips double quotes from module paths in a require block', () => {
    const content =
      'module example.com/x\n\nrequire (\n\t"gopkg.in/check.v1" v0.0.0-20161208181325-20d25e280405\n)\n';
    const deps = parseGoMod(content);
    assert.equal(deps.length, 1);
    assert.deepEqual(deps[0], { name: 'gopkg.in/check.v1', version: 'v0.0.0-20161208181325-20d25e280405', indirect: false });
  });

  it('strips double quotes from a single-line require', () => {
    const content = 'module example.com/x\n\nrequire "gopkg.in/check.v1" v0.0.0-20161208181325-20d25e280405\n';
    const deps = parseGoMod(content);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].name, 'gopkg.in/check.v1');
    assert.equal(deps[0].version, 'v0.0.0-20161208181325-20d25e280405');
  });
});
