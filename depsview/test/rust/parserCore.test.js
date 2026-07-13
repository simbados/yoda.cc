import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeCrateName,
  parseCargoToml,
  isCratesIoSource,
  parseCargoLock,
} from '../../src/rust/parserCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

// ── normalizeCrateName ────────────────────────────────────────────────────────

describe('normalizeCrateName', () => {
  it('lowercases the crate name', () => {
    assert.equal(normalizeCrateName('Serde'), 'serde');
  });

  it('collapses runs of hyphens and underscores to a single hyphen', () => {
    assert.equal(normalizeCrateName('foo_bar'), 'foo-bar');
    assert.equal(normalizeCrateName('foo-bar'), 'foo-bar');
    assert.equal(normalizeCrateName('foo__bar'), 'foo-bar');
    assert.equal(normalizeCrateName('foo-_-bar'), 'foo-bar');
  });

  it('treats foo-bar and foo_bar as the same key', () => {
    assert.equal(normalizeCrateName('foo-bar'), normalizeCrateName('foo_bar'));
  });
});

// ── parseCargoToml ────────────────────────────────────────────────────────────

describe('parseCargoToml', () => {
  describe('basic dependency tables', () => {
    it('reads [dependencies] with bare version strings', () => {
      const content = '[dependencies]\nserde = "1.0"\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'serde', versionSpec: '1.0' }]);
    });

    it('reads [build-dependencies] alongside [dependencies]', () => {
      const content = '[dependencies]\nserde = "1.0"\n\n[build-dependencies]\ncc = "1.0"\n';
      const { deps } = parseCargoToml(content);
      const names = deps.map(d => d.name);
      assert.ok(names.includes('serde'));
      assert.ok(names.includes('cc'));
    });

    it('excludes [dev-dependencies] when includeDev is false', () => {
      const content = '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n';
      const { deps } = parseCargoToml(content, false);
      const names = deps.map(d => d.name);
      assert.ok(names.includes('serde'));
      assert.ok(!names.includes('criterion'));
    });

    it('includes [dev-dependencies] when includeDev is true', () => {
      const content = '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n';
      const { deps } = parseCargoToml(content, true);
      const names = deps.map(d => d.name);
      assert.ok(names.includes('criterion'));
    });
  });

  describe('target-specific dependency tables', () => {
    it('reads [target.\'cfg(...)\'.dependencies]', () => {
      const content = "[target.'cfg(unix)'.dependencies]\nnix = \"0.27\"\n";
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'nix', versionSpec: '0.27' }]);
    });

    it('honours includeDev for [target.\'cfg(...)\'.dev-dependencies]', () => {
      const content = "[target.'cfg(windows)'.dev-dependencies]\nwinapi = \"0.3\"\n";
      assert.equal(parseCargoToml(content, false).deps.length, 0);
      assert.equal(parseCargoToml(content, true).deps.length, 1);
    });
  });

  describe('workspace dependencies', () => {
    it('reads [workspace.dependencies]', () => {
      const content = '[workspace.dependencies]\nserde = "1.0"\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'serde', versionSpec: '1.0' }]);
    });

    it('skips a workspace = true inline-table entry', () => {
      const content = '[dependencies]\nserde = { workspace = true }\n';
      const { deps, dangerousDeps } = parseCargoToml(content);
      assert.deepEqual(deps, []);
      assert.deepEqual(dangerousDeps, []);
    });
  });

  describe('inline tables', () => {
    it('reads the version key from an inline table', () => {
      const content = '[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'serde', versionSpec: '1.0' }]);
    });

    it('resolves the registry crate name from a package = rename', () => {
      const content = '[dependencies]\nmy-serde = { package = "serde", version = "1.0" }\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'serde', versionSpec: '1.0' }]);
    });

    it('records an inline table with no version as versionSpec null', () => {
      const content = '[dependencies]\nrand = { features = ["std"] }\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'rand', versionSpec: null }]);
    });

    it('joins a multi-line inline table', () => {
      const content = [
        '[dependencies]',
        'tokio = {',
        '  version = "1",',
        '  features = ["full"]',
        '}',
      ].join('\n');
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'tokio', versionSpec: '1' }]);
    });
  });

  describe('dangerousDeps for non-registry sources', () => {
    it('flags a git dependency', () => {
      const content = '[dependencies]\npatched = { git = "https://github.com/example/patched" }\n';
      const { deps, dangerousDeps } = parseCargoToml(content);
      assert.deepEqual(deps, []);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].name, 'patched');
      assert.equal(dangerousDeps[0].reason, 'git dependency');
    });

    it('flags a path dependency', () => {
      const content = '[dependencies]\nlocal-lib = { path = "../local-lib" }\n';
      const { dangerousDeps } = parseCargoToml(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].reason, 'path dependency');
    });

    it('flags an alternative registry dependency', () => {
      const content = '[dependencies]\ncorp = { version = "1.0", registry = "corp" }\n';
      const { dangerousDeps } = parseCargoToml(content);
      assert.equal(dangerousDeps.length, 1);
      assert.equal(dangerousDeps[0].reason, 'alternative registry');
    });
  });

  describe('comment stripping and dedup', () => {
    it('strips trailing comments', () => {
      const content = '[dependencies]\nserde = "1.0" # the serde crate\n';
      const { deps } = parseCargoToml(content);
      assert.deepEqual(deps, [{ name: 'serde', versionSpec: '1.0' }]);
    });

    it('deduplicates a crate declared twice in the same table kind', () => {
      const content = '[dependencies]\nserde = "1.0"\nserde = "2.0"\n';
      const { deps } = parseCargoToml(content);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].versionSpec, '1.0');
    });
  });

  describe('empty and fixture inputs', () => {
    it('returns empty arrays for empty input', () => {
      assert.deepEqual(parseCargoToml(''), { deps: [], dangerousDeps: [] });
    });

    it('parses the manifest-only fixture', () => {
      const content = fs.readFileSync(path.join(FIXTURES, 'cargo-toml', 'Cargo.toml'), 'utf8');
      const { deps, dangerousDeps } = parseCargoToml(content, false);
      const names = deps.map(d => d.name).sort();
      assert.deepEqual(names, ['cc', 'nix', 'rand', 'serde']);
      const dangerNames = dangerousDeps.map(d => d.name).sort();
      assert.deepEqual(dangerNames, ['local-lib', 'patched']);
    });

    it('includes criterion from the manifest-only fixture when includeDev is true', () => {
      const content = fs.readFileSync(path.join(FIXTURES, 'cargo-toml', 'Cargo.toml'), 'utf8');
      const { deps } = parseCargoToml(content, true);
      assert.ok(deps.map(d => d.name).includes('criterion'));
    });
  });
});

// ── isCratesIoSource ──────────────────────────────────────────────────────────

describe('isCratesIoSource', () => {
  it('returns true for the legacy git registry URL', () => {
    assert.equal(isCratesIoSource('registry+https://github.com/rust-lang/crates.io-index'), true);
  });

  it('returns true for the sparse registry URL', () => {
    assert.equal(isCratesIoSource('sparse+https://index.crates.io/'), true);
  });

  it('returns false for a git source', () => {
    assert.equal(isCratesIoSource('git+https://github.com/example/foo'), false);
  });

  it('returns false for an alternative registry', () => {
    assert.equal(isCratesIoSource('registry+https://registry.corp.invalid/index'), false);
  });

  it('returns false for null and undefined', () => {
    assert.equal(isCratesIoSource(null), false);
    assert.equal(isCratesIoSource(undefined), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isCratesIoSource(''), false);
  });
});

// ── parseCargoLock ────────────────────────────────────────────────────────────

describe('parseCargoLock', () => {
  it('parses [[package]] entries with name, version, and source', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'), 'utf8');
    const packages = parseCargoLock(content);
    const serde = packages.find(p => p.name === 'serde');
    assert.deepEqual(serde, {
      name: 'serde',
      version: '1.0.197',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    });
  });

  it('keeps packages with source null', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'), 'utf8');
    const packages = parseCargoLock(content);
    const app = packages.find(p => p.name === 'demo-app');
    assert.equal(app.source, null);
  });

  it('parses every package in the fixture including sparse and git sources', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'), 'utf8');
    const packages = parseCargoLock(content);
    const names = packages.map(p => p.name).sort();
    assert.deepEqual(names, ['demo-app', 'internal-utils', 'serde', 'serde_derive', 'tokio']);
    assert.equal(packages.find(p => p.name === 'tokio').source, 'sparse+https://index.crates.io/');
    assert.ok(packages.find(p => p.name === 'internal-utils').source.startsWith('git+'));
  });

  it('skips over a multi-line dependencies array without emitting spurious packages', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'cargo-lock', 'Cargo.lock'), 'utf8');
    const packages = parseCargoLock(content);
    assert.equal(packages.length, 5);
    assert.ok(!packages.some(p => p.name === 'serde_derive' && p.version !== '1.0.197'));
  });

  it('deduplicates identical name@version@source entries', () => {
    const content = [
      '[[package]]',
      'name = "serde"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
      '[[package]]',
      'name = "serde"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\n');
    assert.equal(parseCargoLock(content).length, 1);
  });

  it('keeps distinct versions of the same crate', () => {
    const content = [
      '[[package]]',
      'name = "libc"',
      'version = "0.2.1"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
      '[[package]]',
      'name = "libc"',
      'version = "0.2.2"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\n');
    assert.equal(parseCargoLock(content).length, 2);
  });

  it('drops packages missing a name or version', () => {
    const content = '[[package]]\nversion = "1.0.0"\n\n[[package]]\nname = "ok"\nversion = "1.0.0"\n';
    const packages = parseCargoLock(content);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].name, 'ok');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseCargoLock(''), []);
  });

  it('handles a single-line dependencies array', () => {
    const content = [
      '[[package]]',
      'name = "foo"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'dependencies = ["bar", "baz"]',
      '',
      '[[package]]',
      'name = "bar"',
      'version = "2.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\n');
    const packages = parseCargoLock(content);
    assert.equal(packages.length, 2);
    assert.equal(packages[0].name, 'foo');
    assert.equal(packages[1].name, 'bar');
  });
});
