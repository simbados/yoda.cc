import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicNpmResolved, partitionNpmPackages } from '../../src/npm/registryFilter.js';

// ── isPublicNpmResolved ───────────────────────────────────────────────────────

describe('isPublicNpmResolved', () => {
  it('returns true for a URL pointing to registry.npmjs.org', () => {
    assert.equal(
      isPublicNpmResolved('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'),
      true,
    );
  });

  it('returns true for null (treated as public)', () => {
    assert.equal(isPublicNpmResolved(null), true);
  });

  it('returns true for undefined (treated as public)', () => {
    assert.equal(isPublicNpmResolved(undefined), true);
  });

  it('returns true for empty string (falsy, treated as public)', () => {
    assert.equal(isPublicNpmResolved(''), true);
  });

  it('returns false for a private registry URL', () => {
    assert.equal(
      isPublicNpmResolved('https://my-private-registry.example.com/lodash/-/lodash-4.17.21.tgz'),
      false,
    );
  });

  it('returns false for a GitHub Packages URL', () => {
    assert.equal(
      isPublicNpmResolved('https://npm.pkg.github.com/@myorg/mypackage/-/mypackage-1.0.0.tgz'),
      false,
    );
  });

  it('returns false for a Verdaccio / Artifactory URL', () => {
    assert.equal(
      isPublicNpmResolved('https://verdaccio.corp.internal/private-pkg/-/private-pkg-2.0.0.tgz'),
      false,
    );
  });

  it('returns false when URL contains registry.npmjs.org but not at the start', () => {
    assert.equal(
      isPublicNpmResolved('https://mirror.example.com/proxy/registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'),
      false,
    );
  });

  it('returns true for a scoped package on the public registry', () => {
    assert.equal(
      isPublicNpmResolved('https://registry.npmjs.org/@babel/core/-/core-7.21.0.tgz'),
      true,
    );
  });
});

// ── partitionNpmPackages ──────────────────────────────────────────────────────

describe('partitionNpmPackages — basic partitioning', () => {
  const packages = [
    { name: 'lodash',   version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
    { name: 'internal', version: '1.0.0',   resolved: 'https://private.registry.corp/internal/-/internal-1.0.0.tgz' },
    { name: 'vite',     version: '4.0.0',   resolved: 'https://registry.npmjs.org/vite/-/vite-4.0.0.tgz' },
  ];

  it('publicPkgs contains only the public packages', () => {
    const { publicPkgs } = partitionNpmPackages(packages);
    assert.equal(publicPkgs.length, 2);
    assert.ok(publicPkgs.find(p => p.name === 'lodash'));
    assert.ok(publicPkgs.find(p => p.name === 'vite'));
  });

  it('privateCount reflects the number of private packages', () => {
    const { privateCount } = partitionNpmPackages(packages);
    assert.equal(privateCount, 1);
  });

  it('publicPkgs entries only contain name and version (no resolved field)', () => {
    const { publicPkgs } = partitionNpmPackages(packages);
    for (const pkg of publicPkgs) {
      assert.equal(typeof pkg.name,    'string');
      assert.equal(typeof pkg.version, 'string');
      assert.equal('resolved' in pkg,  false);
    }
  });

  it('privatePkgs contains the private package with name and url', () => {
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.equal(privatePkgs.length, 1);
    assert.equal(privatePkgs[0].name, 'internal');
    assert.equal(privatePkgs[0].url, 'https://private.registry.corp/internal/-/internal-1.0.0.tgz');
  });

  it('privatePkgs entries do not contain a version field', () => {
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.equal('version' in privatePkgs[0], false);
  });
});

describe('partitionNpmPackages — packages with no resolved field', () => {
  const packages = [
    { name: 'workspace-root', version: '1.0.0', resolved: null },
    { name: 'bundled-dep',    version: '2.0.0', resolved: undefined },
    { name: 'private-pkg',   version: '3.0.0', resolved: 'https://private.corp/pkg/-/pkg-3.0.0.tgz' },
  ];

  it('treats null and undefined resolved as public', () => {
    const { publicPkgs } = partitionNpmPackages(packages);
    assert.equal(publicPkgs.length, 2);
    assert.ok(publicPkgs.find(p => p.name === 'workspace-root'));
    assert.ok(publicPkgs.find(p => p.name === 'bundled-dep'));
  });

  it('counts only truly private packages', () => {
    const { privateCount } = partitionNpmPackages(packages);
    assert.equal(privateCount, 1);
  });

  it('privatePkgs excludes packages with null or undefined resolved', () => {
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.equal(privatePkgs.length, 1);
    assert.equal(privatePkgs[0].name, 'private-pkg');
  });
});

describe('partitionNpmPackages — empty and all-public inputs', () => {
  it('returns empty publicPkgs and zero privateCount for empty input', () => {
    const { publicPkgs, privateCount } = partitionNpmPackages([]);
    assert.deepEqual(publicPkgs, []);
    assert.equal(privateCount, 0);
  });

  it('returns empty privatePkgs for empty input', () => {
    const { privatePkgs } = partitionNpmPackages([]);
    assert.deepEqual(privatePkgs, []);
  });

  it('returns all packages as public when none are private', () => {
    const packages = [
      { name: 'a', version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
      { name: 'b', version: '2.0.0', resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz' },
    ];
    const { publicPkgs, privateCount } = partitionNpmPackages(packages);
    assert.equal(publicPkgs.length, 2);
    assert.equal(privateCount, 0);
  });

  it('returns empty privatePkgs when all packages are public', () => {
    const packages = [
      { name: 'a', version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
      { name: 'b', version: '2.0.0', resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz' },
    ];
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.deepEqual(privatePkgs, []);
  });

  it('returns zero publicPkgs and full count when all are private', () => {
    const packages = [
      { name: 'x', version: '1.0.0', resolved: 'https://private.corp/x/-/x-1.0.0.tgz' },
      { name: 'y', version: '2.0.0', resolved: 'https://private.corp/y/-/y-2.0.0.tgz' },
    ];
    const { publicPkgs, privateCount } = partitionNpmPackages(packages);
    assert.deepEqual(publicPkgs, []);
    assert.equal(privateCount, 2);
  });

  it('privatePkgs contains all packages when all are private', () => {
    const packages = [
      { name: 'x', version: '1.0.0', resolved: 'https://private.corp/x/-/x-1.0.0.tgz' },
      { name: 'y', version: '2.0.0', resolved: 'https://private.corp/y/-/y-2.0.0.tgz' },
    ];
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.equal(privatePkgs.length, 2);
    assert.equal(privatePkgs[0].name, 'x');
    assert.equal(privatePkgs[0].url, 'https://private.corp/x/-/x-1.0.0.tgz');
    assert.equal(privatePkgs[1].name, 'y');
    assert.equal(privatePkgs[1].url, 'https://private.corp/y/-/y-2.0.0.tgz');
  });
});

describe('partitionNpmPackages — does not mutate the input array', () => {
  it('leaves the original array unchanged', () => {
    const packages = [
      { name: 'lodash', version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
    ];
    const originalLength = packages.length;
    const originalFirst  = { ...packages[0] };
    partitionNpmPackages(packages);
    assert.equal(packages.length, originalLength);
    assert.deepEqual(packages[0], originalFirst);
  });
});

describe('partitionNpmPackages — scoped packages', () => {
  it('handles scoped public packages correctly', () => {
    const packages = [
      { name: '@babel/core', version: '7.21.0', resolved: 'https://registry.npmjs.org/@babel/core/-/core-7.21.0.tgz' },
    ];
    const { publicPkgs, privateCount } = partitionNpmPackages(packages);
    assert.equal(publicPkgs.length, 1);
    assert.equal(publicPkgs[0].name, '@babel/core');
    assert.equal(privateCount, 0);
  });

  it('handles scoped private packages correctly', () => {
    const packages = [
      { name: '@myorg/secret', version: '1.0.0', resolved: 'https://npm.pkg.github.com/@myorg/secret/-/secret-1.0.0.tgz' },
    ];
    const { publicPkgs, privateCount } = partitionNpmPackages(packages);
    assert.deepEqual(publicPkgs, []);
    assert.equal(privateCount, 1);
  });

  it('privatePkgs contains the resolved URL for a scoped private package', () => {
    const packages = [
      { name: '@myorg/secret', version: '1.0.0', resolved: 'https://npm.pkg.github.com/@myorg/secret/-/secret-1.0.0.tgz' },
    ];
    const { privatePkgs } = partitionNpmPackages(packages);
    assert.equal(privatePkgs.length, 1);
    assert.equal(privatePkgs[0].name, '@myorg/secret');
    assert.equal(privatePkgs[0].url, 'https://npm.pkg.github.com/@myorg/secret/-/secret-1.0.0.tgz');
  });
});
