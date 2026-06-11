import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseBunLock,
  parseBunPackageKey,
  stripUrlHash,
  collectDevOnlyNames,
} from '../../src/npm/bunLockParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureContent = fs.readFileSync(
  path.join(__dirname, '../fixtures/bun-lock/bun.lock'),
  'utf8',
);

describe('parseBunPackageKey', () => {
  describe('plain package names', () => {
    it('returns name and version for a plain package key', () => {
      const result = parseBunPackageKey('lodash@4.17.21');
      assert.deepEqual(result, { name: 'lodash', version: '4.17.21' });
    });

    it('returns correct version for a multi-part version string', () => {
      const result = parseBunPackageKey('vite@5.1.0');
      assert.deepEqual(result, { name: 'vite', version: '5.1.0' });
    });
  });

  describe('scoped package names', () => {
    it('returns scoped name and version for @scope/pkg@version', () => {
      const result = parseBunPackageKey('@babel/core@7.24.0');
      assert.deepEqual(result, { name: '@babel/core', version: '7.24.0' });
    });

    it('preserves the full scoped name including the leading @', () => {
      const result = parseBunPackageKey('@scope/package@1.2.3');
      assert.equal(result.name, '@scope/package');
    });
  });

  describe('unparseable input', () => {
    it('returns null when there is no @ at all', () => {
      assert.equal(parseBunPackageKey('lodash'), null);
    });

    it('returns null when the only @ is at position 0 (bare scoped name without version)', () => {
      assert.equal(parseBunPackageKey('@scope/pkg'), null);
    });

    it('returns null for an empty string', () => {
      assert.equal(parseBunPackageKey(''), null);
    });
  });
});

describe('stripUrlHash', () => {
  it('strips the #hash suffix from a URL', () => {
    const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c';
    assert.equal(
      stripUrlHash(url),
      'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
    );
  });

  it('returns the URL unchanged when there is no hash', () => {
    const url = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
    assert.equal(stripUrlHash(url), url);
  });

  it('strips everything from the first # onward', () => {
    const url = 'https://example.com/pkg.tgz#abc123';
    assert.equal(stripUrlHash(url), 'https://example.com/pkg.tgz');
  });

  it('returns an empty string unchanged', () => {
    assert.equal(stripUrlHash(''), '');
  });
});

describe('collectDevOnlyNames', () => {
  it('returns a Set containing dev-only names', () => {
    const workspaces = {
      '': {
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { eslint: '^8.57.0' },
      },
    };
    const result = collectDevOnlyNames(workspaces);
    assert.ok(result instanceof Set);
    assert.ok(result.has('eslint'));
  });

  it('does not include names that appear in both deps and devDeps', () => {
    const workspaces = {
      '': {
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { lodash: '^4.17.21', eslint: '^8.57.0' },
      },
    };
    const result = collectDevOnlyNames(workspaces);
    assert.ok(!result.has('lodash'));
    assert.ok(result.has('eslint'));
  });

  it('returns an empty Set when there are no devDependencies', () => {
    const workspaces = {
      '': { dependencies: { lodash: '^4.17.21' } },
    };
    assert.equal(collectDevOnlyNames(workspaces).size, 0);
  });

  it('returns an empty Set for empty workspaces object', () => {
    assert.equal(collectDevOnlyNames({}).size, 0);
  });

  it('handles workspaces with no dependencies or devDependencies keys', () => {
    const workspaces = { '': { name: 'my-app' } };
    assert.equal(collectDevOnlyNames(workspaces).size, 0);
  });

  it('aggregates across multiple workspaces — name in prod of one workspace is not dev-only', () => {
    const workspaces = {
      '':        { devDependencies: { lodash: '^4.17.21' } },
      packages: { dependencies: { lodash: '^4.17.21' } },
    };
    const result = collectDevOnlyNames(workspaces);
    assert.ok(!result.has('lodash'));
  });
});

describe('parseBunLock', () => {
  describe('fixture file — includeTests=false (default)', () => {
    it('returns exactly 4 packages (3 prod + 1 private registry)', () => {
      assert.equal(parseBunLock(fixtureContent).length, 4);
    });

    it('includes lodash', () => {
      assert.ok(parseBunLock(fixtureContent).find(d => d.name === 'lodash'));
    });

    it('includes vite', () => {
      assert.ok(parseBunLock(fixtureContent).find(d => d.name === 'vite'));
    });

    it('includes @babel/core', () => {
      assert.ok(parseBunLock(fixtureContent).find(d => d.name === '@babel/core'));
    });

    it('includes the private-registry package internal-lib', () => {
      assert.ok(parseBunLock(fixtureContent).find(d => d.name === 'internal-lib'));
    });

    it('excludes eslint dev dep', () => {
      assert.ok(!parseBunLock(fixtureContent).find(d => d.name === 'eslint'));
    });
  });

  describe('fixture file — includeTests=true', () => {
    it('returns exactly 5 packages including eslint', () => {
      assert.equal(parseBunLock(fixtureContent, true).length, 5);
    });

    it('includes eslint when includeTests is true', () => {
      assert.ok(parseBunLock(fixtureContent, true).find(d => d.name === 'eslint'));
    });
  });

  describe('resolved URL handling', () => {
    it('strips the #hash from the lodash resolved URL', () => {
      const lodash = parseBunLock(fixtureContent).find(d => d.name === 'lodash');
      assert.equal(lodash.resolved, 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz');
    });

    it('strips the #hash from the vite resolved URL', () => {
      const vite = parseBunLock(fixtureContent).find(d => d.name === 'vite');
      assert.equal(vite.resolved, 'https://registry.npmjs.org/vite/-/vite-5.1.0.tgz');
    });

    it('strips the #hash from the @babel/core resolved URL', () => {
      const babel = parseBunLock(fixtureContent).find(d => d.name === '@babel/core');
      assert.equal(babel.resolved, 'https://registry.npmjs.org/@babel/core/-/@babel/core-7.24.0.tgz');
    });

    it('preserves the private-registry resolved URL with hash stripped', () => {
      const lib = parseBunLock(fixtureContent).find(d => d.name === 'internal-lib');
      assert.equal(lib.resolved, 'https://my-company.registry.invalid/internal-lib/-/internal-lib-1.0.0.tgz');
    });
  });

  describe('return shape', () => {
    it('every entry has name, version, and resolved fields', () => {
      for (const dep of parseBunLock(fixtureContent, true)) {
        assert.equal(typeof dep.name, 'string');
        assert.equal(typeof dep.version, 'string');
        assert.ok('resolved' in dep);
      }
    });

    it('lodash entry has correct version', () => {
      const lodash = parseBunLock(fixtureContent).find(d => d.name === 'lodash');
      assert.equal(lodash.version, '4.17.21');
    });

    it('eslint entry has correct version when included', () => {
      const eslint = parseBunLock(fixtureContent, true).find(d => d.name === 'eslint');
      assert.equal(eslint.version, '8.57.0');
    });
  });

  describe('empty input', () => {
    it('returns empty array when packages section is empty', () => {
      const content = JSON.stringify({ lockfileVersion: 0, workspaces: {}, packages: {} });
      assert.equal(parseBunLock(content).length, 0);
    });

    it('returns empty array when both workspaces and packages are absent', () => {
      const content = JSON.stringify({ lockfileVersion: 0 });
      assert.equal(parseBunLock(content).length, 0);
    });
  });

  describe('deduplication', () => {
    it('does not return duplicate entries for the same name and version', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { lodash: '^4.17.21' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.filter(d => d.name === 'lodash').length, 1);
    });

    it('returns both entries when versions differ', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { lodash: '^4.17.21' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
          'lodash@3.10.1':  ['lodash@3.10.1',  'https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz',  {}, 'sha512-bbb'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.filter(d => d.name === 'lodash').length, 2);
    });
  });

  describe('invalid JSON', () => {
    it('throws SyntaxError for non-JSON content', () => {
      assert.throws(() => parseBunLock('not json at all'), SyntaxError);
    });

    it('throws SyntaxError for truncated JSON', () => {
      assert.throws(() => parseBunLock('{"lockfileVersion":'), SyntaxError);
    });
  });

  describe('nested path keys resolved via value[0]', () => {
    it('returns the canonical name and version from value[0], not the slash-separated key', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { lodash: '^4.17.21' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
          '@parent/pkg/@child/dep': ['@child/dep@2.0.0', '', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.length, 2);
      const child = deps.find(d => d.name === '@child/dep');
      assert.ok(child, 'expected @child/dep to be present');
      assert.equal(child.version, '2.0.0');
    });

    it('does not produce a garbage entry whose name contains a slash from the key', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { lodash: '^4.17.21' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
          '@parent/pkg/@child/dep': ['@child/dep@2.0.0', '', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      const garbage = deps.find(d => d.name.startsWith('@parent/pkg/'));
      assert.equal(garbage, undefined);
    });
  });

  describe('nested path key deduplication against the canonical entry', () => {
    it('returns only one entry when a nested path key and a direct key resolve to the same name@version', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { '@child/dep': '^2.0.0' } } },
        packages: {
          '@child/dep@2.0.0': ['@child/dep@2.0.0', 'https://registry.npmjs.org/@child/dep/-/@child/dep-2.0.0.tgz', {}, 'sha512-x'],
          '@parent/pkg/@child/dep': ['@child/dep@2.0.0', '', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.filter(d => d.name === '@child/dep').length, 1);
    });

    it('keeps the resolved URL from the canonical direct entry, not the empty nested path entry', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { '@child/dep': '^2.0.0' } } },
        packages: {
          '@child/dep@2.0.0': ['@child/dep@2.0.0', 'https://registry.npmjs.org/@child/dep/-/@child/dep-2.0.0.tgz', {}, 'sha512-x'],
          '@parent/pkg/@child/dep': ['@child/dep@2.0.0', '', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      const child = deps.find(d => d.name === '@child/dep');
      assert.equal(child.resolved, 'https://registry.npmjs.org/@child/dep/-/@child/dep-2.0.0.tgz');
    });
  });

  describe('bare scoped name key (no @version suffix) parsed via value[0]', () => {
    it('returns the package with name and version from value[0] when the key has no version suffix', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { '@babel/code-frame': '^7.24.7' } } },
        packages: {
          '@babel/code-frame': ['@babel/code-frame@7.24.7', 'https://registry.npmjs.org/@babel/code-frame/-/@babel/code-frame-7.24.7.tgz#abc', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].name, '@babel/code-frame');
      assert.equal(deps[0].version, '7.24.7');
    });

    it('strips the #hash from the resolved URL when the key is a bare scoped name', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { '@babel/code-frame': '^7.24.7' } } },
        packages: {
          '@babel/code-frame': ['@babel/code-frame@7.24.7', 'https://registry.npmjs.org/@babel/code-frame/-/@babel/code-frame-7.24.7.tgz#abc', {}, 'sha512-x'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps[0].resolved, 'https://registry.npmjs.org/@babel/code-frame/-/@babel/code-frame-7.24.7.tgz');
    });

    it('does not drop bare scoped name packages (no silent omission)', () => {
      const content = JSON.stringify({
        lockfileVersion: 0,
        workspaces: { '': { dependencies: { '@babel/code-frame': '^7.24.7', lodash: '^4.17.21' } } },
        packages: {
          '@babel/code-frame': ['@babel/code-frame@7.24.7', 'https://registry.npmjs.org/@babel/code-frame/-/@babel/code-frame-7.24.7.tgz', {}, 'sha512-x'],
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
        },
      });
      const deps = parseBunLock(content);
      assert.equal(deps.length, 2);
      assert.ok(deps.find(d => d.name === '@babel/code-frame'));
    });
  });
});
