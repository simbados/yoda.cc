import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitPackageTokens, parseMultiPackageInput } from '../src/multiPackageParser.js';

// ── splitPackageTokens ────────────────────────────────────────────────────────

describe('splitPackageTokens — comma separator', () => {
  it('splits two entries separated by comma without spaces', () => {
    assert.deepEqual(splitPackageTokens('eslint,eslint@9'), ['eslint', 'eslint@9']);
  });

  it('splits two entries separated by comma with space after', () => {
    assert.deepEqual(splitPackageTokens('eslint, eslint@9'), ['eslint', 'eslint@9']);
  });

  it('splits two entries separated by comma with spaces both sides', () => {
    assert.deepEqual(splitPackageTokens('eslint , eslint@9'), ['eslint', 'eslint@9']);
  });

  it('handles trailing comma gracefully', () => {
    assert.deepEqual(splitPackageTokens('eslint, eslint@9,'), ['eslint', 'eslint@9']);
  });

  it('handles leading comma gracefully', () => {
    assert.deepEqual(splitPackageTokens(',eslint'), ['eslint']);
  });

  it('splits three comma-separated entries', () => {
    assert.deepEqual(splitPackageTokens('a, b, c'), ['a', 'b', 'c']);
  });
});

describe('splitPackageTokens — newline separator', () => {
  it('splits entries on newlines', () => {
    assert.deepEqual(splitPackageTokens('eslint\neslint@9'), ['eslint', 'eslint@9']);
  });

  it('skips blank lines', () => {
    assert.deepEqual(splitPackageTokens('eslint\n\neslint@9'), ['eslint', 'eslint@9']);
  });

  it('handles Windows line endings', () => {
    assert.deepEqual(splitPackageTokens('eslint\r\neslint@9'), ['eslint', 'eslint@9']);
  });

  it('trims whitespace from each line', () => {
    assert.deepEqual(splitPackageTokens('  eslint  \n  eslint@9  '), ['eslint', 'eslint@9']);
  });
});

describe('splitPackageTokens — spaced separator', () => {
  it('splits on space-backslash-space', () => {
    assert.deepEqual(splitPackageTokens('eslint \\ eslint@8'), ['eslint', 'eslint@8']);
  });

  it('splits on space-pipe-space', () => {
    assert.deepEqual(splitPackageTokens('eslint | eslint@8'), ['eslint', 'eslint@8']);
  });

  it('splits on space-semicolon-space', () => {
    assert.deepEqual(splitPackageTokens('eslint ; eslint@8'), ['eslint', 'eslint@8']);
  });

  it('does not split on unspaced separator characters', () => {
    // Backslash without surrounding spaces is not treated as a separator
    assert.deepEqual(splitPackageTokens('eslint\\eslint@8'), ['eslint\\eslint@8']);
  });

  it('does not split on one-sided space around separator', () => {
    // Needs space on BOTH sides
    assert.deepEqual(splitPackageTokens('eslint |eslint@8'), ['eslint |eslint@8']);
  });
});

describe('splitPackageTokens — package chars not treated as separators', () => {
  it('does not split Go module paths on forward slash', () => {
    assert.deepEqual(
      splitPackageTokens('github.com/gin-gonic/gin'),
      ['github.com/gin-gonic/gin']
    );
  });

  it('does not split Python version specifiers on =, >, <', () => {
    assert.deepEqual(splitPackageTokens('requests>=2.0'), ['requests>=2.0']);
    assert.deepEqual(splitPackageTokens('requests<3.0'), ['requests<3.0']);
    assert.deepEqual(splitPackageTokens('requests!=2.29.0'), ['requests!=2.29.0']);
  });

  it('does not split scoped npm package names on @', () => {
    assert.deepEqual(splitPackageTokens('@babel/core'), ['@babel/core']);
  });

  it('does not split scoped npm package with version on @', () => {
    assert.deepEqual(splitPackageTokens('@babel/core@7.24'), ['@babel/core@7.24']);
  });
});

describe('splitPackageTokens — mixed separators', () => {
  it('comma and newline together', () => {
    assert.deepEqual(splitPackageTokens('eslint, eslint@9\n@babel/core'), ['eslint', 'eslint@9', '@babel/core']);
  });

  it('comma then pipe', () => {
    assert.deepEqual(splitPackageTokens('a, b | c'), ['a', 'b', 'c']);
  });

  it('three Go modules on separate lines', () => {
    const input = 'github.com/gin-gonic/gin\ngithub.com/go-chi/chi\ngithub.com/pkg/errors';
    assert.deepEqual(splitPackageTokens(input), [
      'github.com/gin-gonic/gin',
      'github.com/go-chi/chi',
      'github.com/pkg/errors',
    ]);
  });
});

describe('splitPackageTokens — edge cases', () => {
  it('returns empty array for empty string', () => {
    assert.deepEqual(splitPackageTokens(''), []);
  });

  it('returns empty array for whitespace-only string', () => {
    assert.deepEqual(splitPackageTokens('   \n\n  '), []);
  });

  it('returns single entry for a single package', () => {
    assert.deepEqual(splitPackageTokens('eslint'), ['eslint']);
  });

  it('handles comma-only string', () => {
    assert.deepEqual(splitPackageTokens(','), []);
  });
});

describe('splitPackageTokens — trailing non-package characters stripped', () => {
  it('strips trailing backslash from shell line-continuation syntax', () => {
    const input = 'golang.org/x/tools/gopls@latest \\\nhonnef.co/go/tools/cmd/staticcheck@latest';
    assert.deepEqual(splitPackageTokens(input), [
      'golang.org/x/tools/gopls@latest',
      'honnef.co/go/tools/cmd/staticcheck@latest',
    ]);
  });

  it('strips trailing pipe character from a token', () => {
    assert.deepEqual(splitPackageTokens('eslint|\neslint@9'), ['eslint', 'eslint@9']);
  });

  it('strips leading pipe character from a token', () => {
    assert.deepEqual(splitPackageTokens('eslint\n|eslint@9'), ['eslint', 'eslint@9']);
  });

  it('strips trailing semicolon from a token', () => {
    assert.deepEqual(splitPackageTokens('eslint;\neslint@9'), ['eslint', 'eslint@9']);
  });

  it('does not strip backslash from the middle of a token', () => {
    assert.deepEqual(splitPackageTokens('eslint\\eslint@9'), ['eslint\\eslint@9']);
  });
});

// ── parseMultiPackageInput ────────────────────────────────────────────────────

describe('parseMultiPackageInput — npm', () => {
  it('parses two comma-separated npm packages', () => {
    assert.deepEqual(parseMultiPackageInput('eslint, eslint@9', 'npm'), [
      { name: 'eslint', version: 'latest' },
      { name: 'eslint', version: '9' },
    ]);
  });

  it('parses scoped package on its own line', () => {
    assert.deepEqual(parseMultiPackageInput('@babel/core\n@babel/parser@7', 'npm'), [
      { name: '@babel/core', version: 'latest' },
      { name: '@babel/parser', version: '7' },
    ]);
  });
});

describe('parseMultiPackageInput — python', () => {
  it('parses two newline-separated python packages', () => {
    assert.deepEqual(parseMultiPackageInput('requests\nflask>=2.0', 'python'), [
      { name: 'requests', version: null },
      { name: 'flask', version: '>=2.0' },
    ]);
  });

  it('parses comma-separated python packages with specifiers', () => {
    assert.deepEqual(parseMultiPackageInput('requests==2.31.0, flask<3', 'python'), [
      { name: 'requests', version: '==2.31.0' },
      { name: 'flask', version: '<3' },
    ]);
  });
});

describe('parseMultiPackageInput — go', () => {
  it('parses two newline-separated go modules', () => {
    assert.deepEqual(
      parseMultiPackageInput('github.com/gin-gonic/gin\ngithub.com/pkg/errors@v0.9.0', 'go'),
      [
        { name: 'github.com/gin-gonic/gin', version: 'latest' },
        { name: 'github.com/pkg/errors', version: 'v0.9.0' },
      ]
    );
  });

  it('parses pipe-separated go modules', () => {
    assert.deepEqual(
      parseMultiPackageInput('github.com/gin-gonic/gin | github.com/go-chi/chi', 'go'),
      [
        { name: 'github.com/gin-gonic/gin', version: 'latest' },
        { name: 'github.com/go-chi/chi', version: 'latest' },
      ]
    );
  });
});

describe('parseMultiPackageInput — edge cases', () => {
  it('returns empty array for blank input', () => {
    assert.deepEqual(parseMultiPackageInput('', 'npm'), []);
  });

  it('returns single entry for one package', () => {
    assert.deepEqual(parseMultiPackageInput('eslint@8', 'npm'), [
      { name: 'eslint', version: '8' },
    ]);
  });
});
