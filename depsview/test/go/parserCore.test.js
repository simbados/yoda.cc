import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGoSum,
  parseGoMod,
  parseGoModReplaces,
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

// ── parseGoModReplaces ────────────────────────────────────────────────────────

describe('parseGoModReplaces', () => {
  describe('empty and no-replace inputs', () => {
    it('returns empty arrays for empty content', () => {
      const result = parseGoModReplaces('');
      assert.deepEqual(result, { dangerousDeps: [], redirectDeps: [] });
    });

    it('returns empty arrays for go.mod with no replace directives', () => {
      const content = 'module example.com/myapp\n\ngo 1.21\n\nrequire github.com/foo/bar v1.0.0\n';
      const result = parseGoModReplaces(content);
      assert.deepEqual(result, { dangerousDeps: [], redirectDeps: [] });
    });
  });

  describe('single-line replace with local path', () => {
    it('returns a dangerousDep for a single-line replace with a relative local path using ./', () => {
      const content = 'module example.com/myapp\n\nreplace github.com/foo/bar => ./local/bar\n';
      const { dangerousDeps, redirectDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(redirectDeps.length, 0);
      assert.equal(dangerousDeps[0].name, 'github.com/foo/bar');
      assert.equal(dangerousDeps[0].spec, 'github.com/foo/bar => ./local/bar');
      assert.equal(dangerousDeps[0].reason, 'local path replace');
    });

    it('returns a dangerousDep for a single-line replace with a parent-relative path using ../', () => {
      const content = 'module example.com/myapp\n\nreplace github.com/foo/bar => ../sibling/bar\n';
      const { dangerousDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].spec, 'github.com/foo/bar => ../sibling/bar');
    });
  });

  describe('single-line replace with fork redirect', () => {
    it('returns a redirectDep for a single-line replace pointing to another module', () => {
      const content = 'module example.com/myapp\n\nreplace github.com/orig/pkg => github.com/fork/pkg v1.2.3\n';
      const { dangerousDeps, redirectDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 0);
      assert.equal(redirectDeps.length, 1);
      assert.equal(redirectDeps[0].name, 'github.com/orig/pkg');
      assert.equal(redirectDeps[0].replacement, 'github.com/fork/pkg');
    });
  });

  describe('block replace with mixed entries', () => {
    it('separates local path and fork redirect entries in a replace block', () => {
      const content = [
        'module example.com/myapp',
        '',
        'replace (',
        '\tgithub.com/local/dep => ./vendor/dep',
        '\tgithub.com/orig/mod v1.0.0 => github.com/fork/mod v1.0.1',
        ')',
      ].join('\n');
      const { dangerousDeps, redirectDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].name, 'github.com/local/dep');
      assert.equal(redirectDeps.length, 1);
      assert.equal(redirectDeps[0].name, 'github.com/orig/mod');
      assert.equal(redirectDeps[0].replacement, 'github.com/fork/mod');
    });

    it('ignores comment lines inside a replace block', () => {
      const content = [
        'module example.com/myapp',
        '',
        'replace (',
        '\t// this is a comment',
        '\tgithub.com/foo/bar => ./local/bar',
        ')',
      ].join('\n');
      const { dangerousDeps, redirectDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(redirectDeps.length, 0);
    });

    it('handles multiple local path replaces in a block', () => {
      const content = [
        'module example.com/myapp',
        '',
        'replace (',
        '\tgithub.com/a/b => ./local/b',
        '\tgithub.com/c/d => ./local/d',
        ')',
      ].join('\n');
      const { dangerousDeps, redirectDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 2);
      assert.equal(redirectDeps.length, 0);
    });
  });

  describe('strip comments from lines', () => {
    it('strips inline comments from a replace line', () => {
      const content = 'module example.com/myapp\n\nreplace github.com/foo/bar => ./local/bar // dev only\n';
      const { dangerousDeps } = parseGoModReplaces(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].name, 'github.com/foo/bar');
    });
  });

  describe('does not mutate input', () => {
    it('returns new arrays and does not modify the input string', () => {
      const content = 'module example.com/myapp\n\nreplace github.com/foo/bar => ./local/bar\n';
      const original = content;
      parseGoModReplaces(content);
      assert.equal(content, original);
    });
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
