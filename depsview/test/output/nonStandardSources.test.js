import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainOf,
  groupByDomain,
} from '../../src/output/nonStandardSources.js';

describe('domainOf', () => {
  describe('valid URL strings', () => {
    it('returns the hostname from an https URL', () => {
      assert.equal(domainOf('https://evil.example.invalid/pkg.tar.gz'), 'evil.example.invalid');
    });

    it('returns the hostname from an http URL', () => {
      assert.equal(domainOf('http://internal.invalid/repo/pkg-1.0.0.tgz'), 'internal.invalid');
    });

    it('returns the hostname from a URL with a path and query string', () => {
      assert.equal(domainOf('https://npm.pkg.github.com/@myorg/mypkg/-/mypkg-1.0.0.tgz'), 'npm.pkg.github.com');
    });

    it('returns the hostname from a URL with a port', () => {
      assert.equal(domainOf('https://registry.corp.invalid:4873/pkg/-/pkg-2.0.0.tgz'), 'registry.corp.invalid');
    });
  });

  describe('non-URL strings (Go module path fallback)', () => {
    it('returns the first path segment for a Go module path', () => {
      assert.equal(domainOf('corp.invalid/pkg'), 'corp.invalid');
    });

    it('returns the first path segment for a multi-segment Go path', () => {
      assert.equal(domainOf('private.registry.example.invalid/group/project'), 'private.registry.example.invalid');
    });

    it('returns the whole string when there is no slash', () => {
      assert.equal(domainOf('singletoken'), 'singletoken');
    });

    it('returns the full string for a "." relative path (not a valid domain label)', () => {
      assert.equal(domainOf('./local'), './local');
    });

    it('returns the full string for a ".." relative path (not a valid domain label)', () => {
      assert.equal(domainOf('../parent'), '../parent');
    });
  });
});

describe('groupByDomain', () => {
  it('returns an empty Map for an empty input array', () => {
    const result = groupByDomain([]);
    assert.equal(result.size, 0);
  });

  it('groups a single package under its domain', () => {
    const result = groupByDomain([
      { name: 'mypkg', url: 'https://registry.corp/mypkg/-/mypkg-1.0.0.tgz' },
    ]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get('registry.corp'), ['mypkg']);
  });

  it('groups multiple packages from the same domain together', () => {
    const result = groupByDomain([
      { name: 'pkgA', url: 'https://private.invalid/pkgA/-/pkgA-1.0.0.tgz' },
      { name: 'pkgB', url: 'https://private.invalid/pkgB/-/pkgB-2.0.0.tgz' },
    ]);
    assert.equal(result.size, 1);
    const names = result.get('private.invalid');
    assert.deepEqual(names, ['pkgA', 'pkgB']);
  });

  it('creates separate domain entries for packages from different domains', () => {
    const result = groupByDomain([
      { name: 'pkgA', url: 'https://registrya.invalid/pkgA/-/pkgA-1.0.0.tgz' },
      { name: 'pkgB', url: 'https://registryb.invalid/pkgB/-/pkgB-2.0.0.tgz' },
    ]);
    assert.equal(result.size, 2);
    assert.deepEqual(result.get('registrya.invalid'), ['pkgA']);
    assert.deepEqual(result.get('registryb.invalid'), ['pkgB']);
  });

  it('handles Go module paths (non-URL) by using the first path segment as domain', () => {
    const result = groupByDomain([
      { name: 'corp.invalid/mylib', url: 'corp.invalid/mylib' },
    ]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get('corp.invalid'), ['corp.invalid/mylib']);
  });

  it('preserves insertion order across different domains', () => {
    const result = groupByDomain([
      { name: 'first', url: 'https://alpha.example.invalid/first-1.0.0.tgz' },
      { name: 'second', url: 'https://beta.example.invalid/second-1.0.0.tgz' },
      { name: 'third', url: 'https://alpha.example.invalid/third-1.0.0.tgz' },
    ]);
    const keys = [...result.keys()];
    assert.deepEqual(keys, ['alpha.example.invalid', 'beta.example.invalid']);
    assert.deepEqual(result.get('alpha.example.invalid'), ['first', 'third']);
  });
});
