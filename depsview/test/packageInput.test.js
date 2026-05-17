import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePackageInput } from '../src/packageInput.js';

// ── npm ────────────────────────────────────────────────────────────────────────

describe('parsePackageInput — npm', () => {
  it('bare name returns latest', () => {
    assert.deepEqual(parsePackageInput('eslint', 'npm'), { name: 'eslint', version: 'latest' });
  });

  it('name@version splits correctly', () => {
    assert.deepEqual(parsePackageInput('eslint@8', 'npm'), { name: 'eslint', version: '8' });
  });

  it('name@full semver splits correctly', () => {
    assert.deepEqual(parsePackageInput('eslint@8.57.0', 'npm'), { name: 'eslint', version: '8.57.0' });
  });

  it('scoped package without version returns latest', () => {
    assert.deepEqual(parsePackageInput('@babel/core', 'npm'), { name: '@babel/core', version: 'latest' });
  });

  it('scoped package with version splits correctly', () => {
    assert.deepEqual(parsePackageInput('@babel/core@7.24', 'npm'), { name: '@babel/core', version: '7.24' });
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(parsePackageInput('  eslint  ', 'npm'), { name: 'eslint', version: 'latest' });
  });

  it('empty version after @ falls back to latest', () => {
    assert.deepEqual(parsePackageInput('eslint@', 'npm'), { name: 'eslint', version: 'latest' });
  });
});

// ── python ─────────────────────────────────────────────────────────────────────

describe('parsePackageInput — python', () => {
  it('bare name returns null version', () => {
    assert.deepEqual(parsePackageInput('requests', 'python'), { name: 'requests', version: null });
  });

  it('== specifier', () => {
    assert.deepEqual(parsePackageInput('requests==2.31.0', 'python'), { name: 'requests', version: '==2.31.0' });
  });

  it('>= specifier', () => {
    assert.deepEqual(parsePackageInput('requests>=2.0', 'python'), { name: 'requests', version: '>=2.0' });
  });

  it('<= specifier', () => {
    assert.deepEqual(parsePackageInput('requests<=3.0', 'python'), { name: 'requests', version: '<=3.0' });
  });

  it('!= specifier', () => {
    assert.deepEqual(parsePackageInput('requests!=2.0', 'python'), { name: 'requests', version: '!=2.0' });
  });

  it('~= specifier', () => {
    assert.deepEqual(parsePackageInput('requests~=2.28', 'python'), { name: 'requests', version: '~=2.28' });
  });

  it('> specifier', () => {
    assert.deepEqual(parsePackageInput('requests>2.0', 'python'), { name: 'requests', version: '>2.0' });
  });

  it('< specifier', () => {
    assert.deepEqual(parsePackageInput('requests<3', 'python'), { name: 'requests', version: '<3' });
  });

  it('strips whitespace around operator', () => {
    assert.deepEqual(parsePackageInput('requests >= 2.0', 'python'), { name: 'requests', version: '>=2.0' });
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(parsePackageInput('  requests  ', 'python'), { name: 'requests', version: null });
  });

  it('hyphenated package name', () => {
    assert.deepEqual(parsePackageInput('my-package==1.0', 'python'), { name: 'my-package', version: '==1.0' });
  });
});

// ── go ─────────────────────────────────────────────────────────────────────────

describe('parsePackageInput — go', () => {
  it('bare module path returns latest', () => {
    assert.deepEqual(
      parsePackageInput('github.com/gin-gonic/gin', 'go'),
      { name: 'github.com/gin-gonic/gin', version: 'latest' }
    );
  });

  it('module path with exact version', () => {
    assert.deepEqual(
      parsePackageInput('github.com/gin-gonic/gin@v1.9.1', 'go'),
      { name: 'github.com/gin-gonic/gin', version: 'v1.9.1' }
    );
  });

  it('module path with explicit @latest', () => {
    assert.deepEqual(
      parsePackageInput('github.com/gin-gonic/gin@latest', 'go'),
      { name: 'github.com/gin-gonic/gin', version: 'latest' }
    );
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(
      parsePackageInput('  github.com/pkg/errors  ', 'go'),
      { name: 'github.com/pkg/errors', version: 'latest' }
    );
  });

  it('empty version after @ falls back to latest', () => {
    assert.deepEqual(
      parsePackageInput('github.com/pkg/errors@', 'go'),
      { name: 'github.com/pkg/errors', version: 'latest' }
    );
  });
});
