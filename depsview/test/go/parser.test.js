import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDependencyFile, readDirectNamesFromGoMod } from '../../src/go/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES  = path.join(__dirname, '..', 'fixtures');

/**
 * Creates a temporary directory containing the named fixture files copied in.
 * Returns the path; the OS will reap it on process exit (we are not in a long-running test).
 */
function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-go-'));
  for (const [name, source] of Object.entries(files)) {
    fs.copyFileSync(source, path.join(dir, name));
  }
  return dir;
}

// ── parseDependencyFile ───────────────────────────────────────────────────────

describe('go parseDependencyFile', () => {
  it('prefers go.sum over go.mod when both are present', () => {
    const dir = tmpProject({
      'go.sum': path.join(FIXTURES, 'go-sum', 'go.sum'),
      'go.mod': path.join(FIXTURES, 'go-mod', 'go.mod'),
    });
    const { source } = parseDependencyFile(dir);
    assert.equal(source, 'go.sum');
  });

  it('falls back to go.mod when go.sum is absent', () => {
    const dir = tmpProject({ 'go.mod': path.join(FIXTURES, 'go-mod', 'go.mod') });
    const { source, deps } = parseDependencyFile(dir);
    assert.equal(source, 'go.mod');
    assert.ok(deps.length > 0);
  });

  it('throws when neither file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-go-'));
    assert.throws(() => parseDependencyFile(dir), /No Go dependency file found/);
  });
});

// ── private module filtering ──────────────────────────────────────────────────

describe('go parseDependencyFile — private filtering', () => {
  it('returns privateCount 0 for an all-public go.sum', () => {
    const dir = tmpProject({ 'go.sum': path.join(FIXTURES, 'go-sum', 'go.sum') });
    const { privateCount } = parseDependencyFile(dir);
    assert.equal(privateCount, 0);
  });

  it('excludes modules with private hostnames', () => {
    const dir = tmpProject({ 'go.sum': path.join(FIXTURES, 'go-private', 'go.sum') });
    const { deps, privateCount } = parseDependencyFile(dir);
    const names = deps.map(d => d.name);
    assert.equal(privateCount, 1, 'one private module should be skipped');
    assert.ok(names.includes('github.com/gin-gonic/gin'),  'public module should be included');
    assert.ok(names.includes('golang.org/x/crypto'),       'public module should be included');
    assert.ok(!names.includes('corp.internal/secret-pkg'), 'private module should be excluded');
  });

  it('returns privateCount 0 for all-public go.mod', () => {
    const dir = tmpProject({ 'go.mod': path.join(FIXTURES, 'go-mod', 'go.mod') });
    const { privateCount } = parseDependencyFile(dir);
    assert.equal(privateCount, 0);
  });
});

// ── readDirectNamesFromGoMod ──────────────────────────────────────────────────

describe('readDirectNamesFromGoMod', () => {
  it('returns only non-indirect module names from go.mod', () => {
    const dir = tmpProject({ 'go.mod': path.join(FIXTURES, 'go-mod', 'go.mod') });
    const direct = readDirectNamesFromGoMod(dir);
    assert.ok(direct.has('github.com/gin-gonic/gin'));
    assert.ok(direct.has('github.com/stretchr/testify'));
    assert.ok(!direct.has('golang.org/x/crypto'));
  });

  it('returns empty Set when go.mod is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-go-'));
    assert.equal(readDirectNamesFromGoMod(dir).size, 0);
  });
});
