import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainOf,
  groupByDomain,
} from '../../src/output/nonStandardSources.js';

describe('domainOf', () => {
  describe('valid URL strings', () => {
    it('returns the hostname from an https URL', () => {
      assert.equal(domainOf('https://evil.example.com/pkg.tar.gz'), 'evil.example.com');
    });

    it('returns the hostname from an http URL', () => {
      assert.equal(domainOf('http://internal.corp/repo/pkg-1.0.0.tgz'), 'internal.corp');
    });

    it('returns the hostname from a URL with a path and query string', () => {
      assert.equal(domainOf('https://npm.pkg.github.com/@myorg/mypkg/-/mypkg-1.0.0.tgz'), 'npm.pkg.github.com');
    });

    it('returns the hostname from a URL with a port', () => {
      assert.equal(domainOf('https://registry.corp.internal:4873/pkg/-/pkg-2.0.0.tgz'), 'registry.corp.internal');
    });
  });

  describe('non-URL strings (Go module path fallback)', () => {
    it('returns the first path segment for a Go module path', () => {
      assert.equal(domainOf('corp.internal/pkg'), 'corp.internal');
    });

    it('returns the first path segment for a multi-segment Go path', () => {
      assert.equal(domainOf('private.registry.example.com/group/project'), 'private.registry.example.com');
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
      { name: 'pkgA', url: 'https://private.corp/pkgA/-/pkgA-1.0.0.tgz' },
      { name: 'pkgB', url: 'https://private.corp/pkgB/-/pkgB-2.0.0.tgz' },
    ]);
    assert.equal(result.size, 1);
    const names = result.get('private.corp');
    assert.deepEqual(names, ['pkgA', 'pkgB']);
  });

  it('creates separate domain entries for packages from different domains', () => {
    const result = groupByDomain([
      { name: 'pkgA', url: 'https://registrya.corp/pkgA/-/pkgA-1.0.0.tgz' },
      { name: 'pkgB', url: 'https://registryb.corp/pkgB/-/pkgB-2.0.0.tgz' },
    ]);
    assert.equal(result.size, 2);
    assert.deepEqual(result.get('registrya.corp'), ['pkgA']);
    assert.deepEqual(result.get('registryb.corp'), ['pkgB']);
  });

  it('handles Go module paths (non-URL) by using the first path segment as domain', () => {
    const result = groupByDomain([
      { name: 'corp.internal/mylib', url: 'corp.internal/mylib' },
    ]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get('corp.internal'), ['corp.internal/mylib']);
  });

  it('preserves insertion order across different domains', () => {
    const result = groupByDomain([
      { name: 'first', url: 'https://alpha.example.com/first-1.0.0.tgz' },
      { name: 'second', url: 'https://beta.example.com/second-1.0.0.tgz' },
      { name: 'third', url: 'https://alpha.example.com/third-1.0.0.tgz' },
    ]);
    const keys = [...result.keys()];
    assert.deepEqual(keys, ['alpha.example.com', 'beta.example.com']);
    assert.deepEqual(result.get('alpha.example.com'), ['first', 'third']);
  });
});
