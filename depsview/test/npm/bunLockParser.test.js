import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseBunLock,
  parseBunDangerousDeps,
  parseBunPackageKey,
  detectBunResolution,
  findVersionDelimiter,
  stripUrlHash,
  collectDevOnlyNames,
} from '../../src/npm/bunLockParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureContent = fs.readFileSync(
  path.join(__dirname, '../fixtures/bun-lock/bun.lock'),
  'utf8',
);

describe('findVersionDelimiter', () => {
  describe('plain package names', () => {
    it('returns the index of the @ between name and version', () => {
      assert.equal(findVersionDelimiter('lodash@4.17.21'), 6);
    });

    it('returns -1 when there is no @ at all', () => {
      assert.equal(findVersionDelimiter('lodash'), -1);
    });

    it('returns -1 for an empty string', () => {
      assert.equal(findVersionDelimiter(''), -1);
    });
  });

  describe('scoped package names', () => {
    it('returns the index of the @ after the scope/name, not the leading @', () => {
      assert.equal(findVersionDelimiter('@babel/core@7.24.0'), 11);
    });

    it('returns -1 for a bare scoped name without a version (only the leading @)', () => {
      assert.equal(findVersionDelimiter('@scope/pkg'), -1);
    });

    it('returns -1 for a leading @ with no slash following', () => {
      assert.equal(findVersionDelimiter('@noslash'), -1);
    });

    it('returns -1 for a leading @ followed only by a slash with nothing after', () => {
      assert.equal(findVersionDelimiter('@scope/'), -1);
    });
  });

  describe('first @ semantics (not lastIndexOf)', () => {
    it('points at the first @ after the name in an npm-alias canonical', () => {
      const canonical = 'alias@npm:real@1.2.3';
      const idx = findVersionDelimiter(canonical);
      assert.equal(idx, 5);
      assert.equal(canonical.slice(0, idx), 'alias');
      assert.equal(canonical.slice(idx + 1), 'npm:real@1.2.3');
      assert.notEqual(idx, canonical.lastIndexOf('@'));
    });

    it('points at the first @ in a git+ssh URL whose spec contains an embedded user@host @', () => {
      const canonical = 'pkg@git+ssh://git@github.com/foo.git#sha';
      const idx = findVersionDelimiter(canonical);
      assert.equal(idx, 3);
      assert.equal(canonical.slice(0, idx), 'pkg');
      assert.notEqual(idx, canonical.lastIndexOf('@'));
    });

    it('points at the first @ after a scoped name even when the spec contains more @ characters', () => {
      const canonical = '@scope/alias@npm:@other/real@1.2.3';
      const idx = findVersionDelimiter(canonical);
      assert.equal(canonical.slice(0, idx), '@scope/alias');
      assert.equal(canonical.slice(idx + 1), 'npm:@other/real@1.2.3');
      assert.notEqual(idx, canonical.lastIndexOf('@'));
    });
  });
});

describe('detectBunResolution', () => {
  describe('npm kind', () => {
    it('returns { kind: "npm", name, version } for a plain canonical', () => {
      assert.deepEqual(
        detectBunResolution('lodash@4.17.21'),
        { name: 'lodash', kind: 'npm', version: '4.17.21' },
      );
    });

    it('returns { kind: "npm", name, version } for a scoped canonical', () => {
      assert.deepEqual(
        detectBunResolution('@babel/core@7.24.0'),
        { name: '@babel/core', kind: 'npm', version: '7.24.0' },
      );
    });
  });

  describe('workspace kind', () => {
    it('detects a workspace canonical', () => {
      assert.deepEqual(
        detectBunResolution('my-app@workspace:packages/web'),
        { name: 'my-app', kind: 'workspace', spec: 'workspace:packages/web' },
      );
    });
  });

  describe('root kind', () => {
    it('detects a root canonical', () => {
      assert.deepEqual(
        detectBunResolution('my-app@root:'),
        { name: 'my-app', kind: 'root', spec: 'root:' },
      );
    });
  });

  describe('alias kind', () => {
    it('detects an npm-alias canonical and keeps the full spec including the inner @', () => {
      assert.deepEqual(
        detectBunResolution('alias@npm:real-name@1.2.3'),
        { name: 'alias', kind: 'alias', spec: 'npm:real-name@1.2.3' },
      );
    });
  });

  describe('file kind', () => {
    it('detects a file: canonical', () => {
      assert.deepEqual(
        detectBunResolution('local@file:./local'),
        { name: 'local', kind: 'file', spec: 'file:./local' },
      );
    });
  });

  describe('link kind', () => {
    it('detects a link: canonical', () => {
      assert.deepEqual(
        detectBunResolution('sibling@link:../sibling'),
        { name: 'sibling', kind: 'link', spec: 'link:../sibling' },
      );
    });
  });

  describe('github kind', () => {
    it('detects a github: canonical', () => {
      assert.deepEqual(
        detectBunResolution('repo@github:owner/repo#sha'),
        { name: 'repo', kind: 'github', spec: 'github:owner/repo#sha' },
      );
    });
  });

  describe('git kind', () => {
    it('detects a git+https canonical', () => {
      assert.deepEqual(
        detectBunResolution('pkg@git+https://example.com/foo.git'),
        { name: 'pkg', kind: 'git', spec: 'git+https://example.com/foo.git' },
      );
    });

    it('detects a git+ssh canonical with embedded user@host', () => {
      assert.deepEqual(
        detectBunResolution('pkg@git+ssh://git@github.com/foo.git#sha'),
        { name: 'pkg', kind: 'git', spec: 'git+ssh://git@github.com/foo.git#sha' },
      );
    });
  });

  describe('tarball kind', () => {
    it('detects an https:// tarball URL', () => {
      assert.deepEqual(
        detectBunResolution('pkg@https://example.com/p.tgz'),
        { name: 'pkg', kind: 'tarball', spec: 'https://example.com/p.tgz' },
      );
    });

    it('detects an http:// tarball URL', () => {
      assert.deepEqual(
        detectBunResolution('pkg@http://example.com/p.tgz'),
        { name: 'pkg', kind: 'tarball', spec: 'http://example.com/p.tgz' },
      );
    });
  });

  describe('null cases', () => {
    it('returns null for a canonical without an @ delimiter', () => {
      assert.equal(detectBunResolution('lodash'), null);
    });

    it('returns null for a bare scoped name without a version', () => {
      assert.equal(detectBunResolution('@scope/pkg'), null);
    });

    it('returns null for the empty string', () => {
      assert.equal(detectBunResolution(''), null);
    });

    it('returns null when the name portion is empty (canonical starts with @ with no scope-slash)', () => {
      assert.equal(detectBunResolution('@1.2.3'), null);
    });

    it('returns null when the spec portion is empty (canonical ends in @)', () => {
      assert.equal(detectBunResolution('lodash@'), null);
    });
  });
});

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

  describe('non-npm resolution kinds', () => {
    it('returns null for a workspace canonical', () => {
      assert.equal(parseBunPackageKey('my-app@workspace:packages/web'), null);
    });

    it('returns null for a root canonical', () => {
      assert.equal(parseBunPackageKey('my-app@root:'), null);
    });

    it('returns null for an npm-alias canonical and does not split on lastIndexOf @', () => {
      assert.equal(parseBunPackageKey('alias@npm:real-name@1.2.3'), null);
    });

    it('returns null for a file: canonical', () => {
      assert.equal(parseBunPackageKey('local@file:./local'), null);
    });

    it('returns null for a link: canonical', () => {
      assert.equal(parseBunPackageKey('sibling@link:../sibling'), null);
    });

    it('returns null for a git+ canonical with embedded user@host', () => {
      assert.equal(
        parseBunPackageKey('pkg@git+ssh://git@github.com/foo.git#sha'),
        null,
      );
    });

    it('returns null for a github: canonical', () => {
      assert.equal(parseBunPackageKey('repo@github:owner/repo#sha'), null);
    });

    it('returns null for an https:// tarball canonical', () => {
      assert.equal(parseBunPackageKey('pkg@https://example.com/p.tgz'), null);
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

  describe('mixed resolution kinds', () => {
    const mixedContent = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': {
          name: 'root-app',
          dependencies: {
            lodash: '^4.17.21',
            'local-folder': 'file:./local',
            'sibling-link': 'link:../sibling',
            'git-pkg': 'git+ssh://git@github.com/foo/bar.git',
            'gh-pkg': 'github:owner/repo',
            'tarball-pkg': 'https://example.com/tarball.tgz',
            'alias-pkg': 'npm:underlying@1.0.0',
            'web-app': 'workspace:packages/web',
          },
        },
      },
      packages: {
        'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
        'web-app': ['web-app@workspace:packages/web'],
        'root-app': ['root-app@root:', {}],
        'alias-pkg': ['alias-pkg@npm:underlying@1.0.0', 'https://registry.npmjs.org/underlying/-/underlying-1.0.0.tgz', {}, 'sha512-bbb'],
        'local-folder': ['local-folder@file:./local', {}],
        'sibling-link': ['sibling-link@link:../sibling', {}],
        'git-pkg': ['git-pkg@git+ssh://git@github.com/foo/bar.git#abc123', {}],
        'gh-pkg': ['gh-pkg@github:owner/repo#sha', {}],
        'tarball-pkg': ['tarball-pkg@https://example.com/tarball.tgz', {}],
      },
    });

    it('returns only the plain npm registry entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].name, 'lodash');
      assert.equal(deps[0].version, '4.17.21');
    });

    it('does not include the workspace entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'web-app'), undefined);
    });

    it('does not include the root entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'root-app'), undefined);
    });

    it('does not include the npm-alias entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'alias-pkg'), undefined);
    });

    it('does not include the file: entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'local-folder'), undefined);
    });

    it('does not include the link: entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'sibling-link'), undefined);
    });

    it('does not include the git+ entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'git-pkg'), undefined);
    });

    it('does not include the github: entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'gh-pkg'), undefined);
    });

    it('does not include the https:// tarball entry', () => {
      const deps = parseBunLock(mixedContent, true);
      assert.equal(deps.find(d => d.name === 'tarball-pkg'), undefined);
    });
  });
});

describe('parseBunDangerousDeps', () => {
  describe('per-kind detection', () => {
    it('returns a file: entry with the file reason', () => {
      const content = JSON.stringify({
        packages: {
          'local-folder': ['local-folder@file:./local', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], {
        name: 'local-folder',
        spec: 'file:./local',
        reason: 'local folder reference (file:)',
      });
    });

    it('returns a link: entry with the link reason', () => {
      const content = JSON.stringify({
        packages: {
          'sibling-link': ['sibling-link@link:../sibling', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], {
        name: 'sibling-link',
        spec: 'link:../sibling',
        reason: 'symlinked folder (link:)',
      });
    });

    it('returns a git+ entry with the git reason and preserves embedded user@host in the spec', () => {
      const content = JSON.stringify({
        packages: {
          'git-pkg': ['git-pkg@git+ssh://git@github.com/foo/bar.git#abc123', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], {
        name: 'git-pkg',
        spec: 'git+ssh://git@github.com/foo/bar.git#abc123',
        reason: 'git source (git+)',
      });
    });

    it('returns a github: entry with the github reason', () => {
      const content = JSON.stringify({
        packages: {
          'gh-pkg': ['gh-pkg@github:owner/repo#sha', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], {
        name: 'gh-pkg',
        spec: 'github:owner/repo#sha',
        reason: 'github shorthand (github:)',
      });
    });

    it('returns an https:// tarball entry with the tarball reason', () => {
      const content = JSON.stringify({
        packages: {
          'tarball-pkg': ['tarball-pkg@https://example.com/p.tgz', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], {
        name: 'tarball-pkg',
        spec: 'https://example.com/p.tgz',
        reason: 'direct tarball URL',
      });
    });

    it('returns an http:// tarball entry with the tarball reason', () => {
      const content = JSON.stringify({
        packages: {
          'tarball-pkg': ['tarball-pkg@http://example.com/p.tgz', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].reason, 'direct tarball URL');
    });
  });

  describe('excluded kinds', () => {
    it('excludes plain npm registry entries', () => {
      const content = JSON.stringify({
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
        },
      });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('excludes workspace entries', () => {
      const content = JSON.stringify({
        packages: {
          'web-app': ['web-app@workspace:packages/web'],
        },
      });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('excludes root entries', () => {
      const content = JSON.stringify({
        packages: {
          'root-app': ['root-app@root:', {}],
        },
      });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('excludes npm-alias entries', () => {
      const content = JSON.stringify({
        packages: {
          'alias-pkg': ['alias-pkg@npm:underlying@1.0.0', 'https://registry.npmjs.org/underlying/-/underlying-1.0.0.tgz', {}, 'sha512-bbb'],
        },
      });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });
  });

  describe('deduplication', () => {
    it('deduplicates by (name, spec) when the same git source appears twice', () => {
      const content = JSON.stringify({
        packages: {
          'git-pkg': ['git-pkg@git+ssh://git@github.com/foo/bar.git#abc', {}],
          'nested/git-pkg': ['git-pkg@git+ssh://git@github.com/foo/bar.git#abc', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'git-pkg');
    });

    it('deduplicates by (name, spec) when the same file source appears twice', () => {
      const content = JSON.stringify({
        packages: {
          'local-a': ['local@file:./local', {}],
          'nested/local-b': ['local@file:./local', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].spec, 'file:./local');
    });

    it('keeps separate entries when the same name has two different specs', () => {
      const content = JSON.stringify({
        packages: {
          'tarball-pkg-a': ['tarball-pkg@https://example.com/v1.tgz', {}],
          'tarball-pkg-b': ['tarball-pkg@https://example.com/v2.tgz', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 2);
    });
  });

  describe('mixed packages', () => {
    it('returns one entry per dangerous kind alongside excluded npm/workspace/root/alias entries', () => {
      const content = JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root-app', dependencies: { lodash: '^4.17.21' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
          'web-app': ['web-app@workspace:packages/web'],
          'root-app': ['root-app@root:', {}],
          'alias-pkg': ['alias-pkg@npm:underlying@1.0.0', 'https://registry.npmjs.org/underlying/-/underlying-1.0.0.tgz', {}, 'sha512-bbb'],
          'local-folder': ['local-folder@file:./local', {}],
          'sibling-link': ['sibling-link@link:../sibling', {}],
          'git-pkg': ['git-pkg@git+ssh://git@github.com/foo/bar.git#abc', {}],
          'gh-pkg': ['gh-pkg@github:owner/repo#sha', {}],
          'tarball-pkg': ['tarball-pkg@https://example.com/p.tgz', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 5);
      assert.ok(out.find(e => e.name === 'local-folder' && e.reason === 'local folder reference (file:)'));
      assert.ok(out.find(e => e.name === 'sibling-link' && e.reason === 'symlinked folder (link:)'));
      assert.ok(out.find(e => e.name === 'git-pkg' && e.reason === 'git source (git+)'));
      assert.ok(out.find(e => e.name === 'gh-pkg' && e.reason === 'github shorthand (github:)'));
      assert.ok(out.find(e => e.name === 'tarball-pkg' && e.reason === 'direct tarball URL'));
    });
  });

  describe('lock file with only plain npm registry entries', () => {
    it('returns an empty array', () => {
      const content = JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root-app', dependencies: { lodash: '^4.17.21', vite: '^5.1.0' } } },
        packages: {
          'lodash@4.17.21': ['lodash@4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', {}, 'sha512-aaa'],
          'vite@5.1.0':     ['vite@5.1.0',     'https://registry.npmjs.org/vite/-/vite-5.1.0.tgz',     {}, 'sha512-bbb'],
        },
      });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('returns an empty array for the fixture file', () => {
      assert.deepEqual(parseBunDangerousDeps(fixtureContent), []);
    });
  });

  describe('invalid or empty input', () => {
    it('returns an empty array for non-JSON content (does not throw)', () => {
      assert.deepEqual(parseBunDangerousDeps('not json at all'), []);
    });

    it('returns an empty array for truncated JSON (does not throw)', () => {
      assert.deepEqual(parseBunDangerousDeps('{"packages":'), []);
    });

    it('returns an empty array when the packages key is missing', () => {
      const content = JSON.stringify({ lockfileVersion: 1, workspaces: {} });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('returns an empty array when packages is an empty object', () => {
      const content = JSON.stringify({ packages: {} });
      assert.deepEqual(parseBunDangerousDeps(content), []);
    });

    it('returns an empty array for an empty string', () => {
      assert.deepEqual(parseBunDangerousDeps(''), []);
    });
  });

  describe('malformed package entries', () => {
    it('skips entries whose value is not an array', () => {
      const content = JSON.stringify({
        packages: {
          'broken': { not: 'an array' },
          'local-folder': ['local-folder@file:./local', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'local-folder');
    });

    it('skips entries whose value[0] is not a string', () => {
      const content = JSON.stringify({
        packages: {
          'broken': [42, {}],
          'local-folder': ['local-folder@file:./local', {}],
        },
      });
      const out = parseBunDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'local-folder');
    });
  });
});
