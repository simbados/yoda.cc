import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDependencyFile, readDirectNamesFromCargoToml } from '../../src/rust/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

/**
 * Creates a temporary directory containing the named fixture files copied in.
 * Returns the path; the OS reaps it on process exit.
 */
function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-rust-'));
  for (const [name, source] of Object.entries(files)) {
    fs.copyFileSync(source, path.join(dir, name));
  }
  return dir;
}

// ── parseDependencyFile ───────────────────────────────────────────────────────

describe('rust parseDependencyFile', () => {
  it('prefers Cargo.lock over Cargo.toml when both are present', () => {
    const dir = tmpProject({
      'Cargo.lock': path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'),
      'Cargo.toml': path.join(FIXTURES, 'cargo-lock', 'Cargo.toml'),
    });
    const { source } = parseDependencyFile(dir);
    assert.equal(source, 'Cargo.lock');
  });

  it('returns only public crates.io packages from Cargo.lock as deps', () => {
    const dir = tmpProject({
      'Cargo.lock': path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'),
      'Cargo.toml': path.join(FIXTURES, 'cargo-lock', 'Cargo.toml'),
    });
    const { deps } = parseDependencyFile(dir);
    const names = deps.map(d => d.name).sort();
    assert.deepEqual(names, ['serde', 'serde_derive', 'tokio']);
  });

  it('counts and lists private git-sourced packages from Cargo.lock', () => {
    const dir = tmpProject({
      'Cargo.lock': path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'),
      'Cargo.toml': path.join(FIXTURES, 'cargo-lock', 'Cargo.toml'),
    });
    const { privateCount, privatePkgs } = parseDependencyFile(dir);
    assert.equal(privateCount, 1);
    assert.equal(privatePkgs[0].name, 'internal-utils');
  });

  it('reads dangerousDeps from Cargo.toml even when Cargo.lock drives resolution', () => {
    const dir = tmpProject({
      'Cargo.lock': path.join(FIXTURES, 'cargo-private', 'Cargo.lock'),
      'Cargo.toml': path.join(FIXTURES, 'cargo-toml', 'Cargo.toml'),
    });
    const { source, dangerousDeps } = parseDependencyFile(dir);
    assert.equal(source, 'Cargo.lock');
    const dangerNames = dangerousDeps.map(d => d.name).sort();
    assert.deepEqual(dangerNames, ['local-lib', 'patched']);
  });

  it('partitions private git and alternative registry sources from the cargo-private lock', () => {
    const dir = tmpProject({
      'Cargo.lock': path.join(FIXTURES, 'cargo-private', 'Cargo.lock'),
    });
    const { deps, privateCount, privatePkgs } = parseDependencyFile(dir);
    assert.deepEqual(deps.map(d => d.name), ['anyhow']);
    assert.equal(privateCount, 2);
    const names = privatePkgs.map(p => p.name).sort();
    assert.deepEqual(names, ['corp-internal', 'corp-registry-lib']);
  });

  it('falls back to Cargo.toml when no Cargo.lock is present', () => {
    const dir = tmpProject({ 'Cargo.toml': path.join(FIXTURES, 'cargo-toml', 'Cargo.toml') });
    const { source, deps, dangerousDeps, privateCount } = parseDependencyFile(dir);
    assert.equal(source, 'Cargo.toml');
    assert.equal(privateCount, 0);
    assert.ok(deps.every(d => 'versionSpec' in d));
    assert.ok(deps.map(d => d.name).includes('serde'));
    assert.equal(dangerousDeps.length, 2);
  });

  it('excludes dev-dependencies from Cargo.toml fallback by default', () => {
    const dir = tmpProject({ 'Cargo.toml': path.join(FIXTURES, 'cargo-toml', 'Cargo.toml') });
    const { deps } = parseDependencyFile(dir);
    assert.ok(!deps.map(d => d.name).includes('criterion'));
  });

  it('includes dev-dependencies from Cargo.toml fallback when includeTests is true', () => {
    const dir = tmpProject({ 'Cargo.toml': path.join(FIXTURES, 'cargo-toml', 'Cargo.toml') });
    const { deps } = parseDependencyFile(dir, { includeTests: true });
    assert.ok(deps.map(d => d.name).includes('criterion'));
  });

  it('throws when neither Cargo.lock nor Cargo.toml exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-rust-'));
    assert.throws(() => parseDependencyFile(dir), /No Rust dependency file found/);
  });
});

// ── readDirectNamesFromCargoToml ──────────────────────────────────────────────

describe('readDirectNamesFromCargoToml', () => {
  it('returns normalised direct crate names from Cargo.toml', () => {
    const dir = tmpProject({ 'Cargo.toml': path.join(FIXTURES, 'cargo-lock', 'Cargo.toml') });
    const direct = readDirectNamesFromCargoToml(dir);
    assert.ok(direct.has('serde'));
    assert.ok(direct.has('tokio'));
    assert.ok(!direct.has('criterion'));
  });

  it('includes dev-dependencies when includeTests is true', () => {
    const dir = tmpProject({ 'Cargo.toml': path.join(FIXTURES, 'cargo-lock', 'Cargo.toml') });
    const direct = readDirectNamesFromCargoToml(dir, true);
    assert.ok(direct.has('criterion'));
  });

  it('normalises underscores to hyphens in crate names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-rust-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[dependencies]\nserde_json = "1.0"\n');
    const direct = readDirectNamesFromCargoToml(dir);
    assert.ok(direct.has('serde-json'));
  });

  it('returns an empty Set when Cargo.toml is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsview-rust-'));
    assert.equal(readDirectNamesFromCargoToml(dir).size, 0);
  });
});
