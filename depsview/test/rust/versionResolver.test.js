import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSemver,
  compareSemver,
  isPreRelease,
  satisfiesRequirement,
  resolveVersion,
} from '../../src/rust/versionResolver.js';

// ── parseSemver ───────────────────────────────────────────────────────────────

describe('parseSemver', () => {
  it('parses a plain three-component version', () => {
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null });
  });

  it('defaults missing components to zero', () => {
    assert.deepEqual(parseSemver('1'), { major: 1, minor: 0, patch: 0, pre: null });
  });

  it('strips build metadata', () => {
    assert.deepEqual(parseSemver('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, pre: null });
  });

  it('splits pre-release identifiers into numbers and strings', () => {
    assert.deepEqual(parseSemver('1.0.0-alpha.1'), { major: 1, minor: 0, patch: 0, pre: ['alpha', 1] });
  });
});

// ── compareSemver ─────────────────────────────────────────────────────────────

describe('compareSemver', () => {
  it('orders by major then minor then patch', () => {
    assert.ok(compareSemver(parseSemver('2.0.0'), parseSemver('1.9.9')) > 0);
    assert.ok(compareSemver(parseSemver('1.2.0'), parseSemver('1.1.9')) > 0);
    assert.ok(compareSemver(parseSemver('1.1.1'), parseSemver('1.1.2')) < 0);
  });

  it('returns 0 for equal versions', () => {
    assert.equal(compareSemver(parseSemver('1.2.3'), parseSemver('1.2.3')), 0);
  });

  it('ranks a pre-release below the corresponding release', () => {
    assert.ok(compareSemver(parseSemver('1.0.0-alpha'), parseSemver('1.0.0')) < 0);
    assert.ok(compareSemver(parseSemver('1.0.0'), parseSemver('1.0.0-alpha')) > 0);
  });

  it('compares numeric pre-release identifiers numerically', () => {
    assert.ok(compareSemver(parseSemver('1.0.0-alpha.2'), parseSemver('1.0.0-alpha.10')) < 0);
  });

  it('ranks numeric pre-release identifiers below string ones', () => {
    assert.ok(compareSemver(parseSemver('1.0.0-1'), parseSemver('1.0.0-alpha')) < 0);
  });

  it('ranks a shorter pre-release set below a longer one with the same prefix', () => {
    assert.ok(compareSemver(parseSemver('1.0.0-alpha'), parseSemver('1.0.0-alpha.1')) < 0);
  });
});

// ── isPreRelease ──────────────────────────────────────────────────────────────

describe('isPreRelease', () => {
  it('returns true for a pre-release version', () => {
    assert.equal(isPreRelease('1.0.0-beta.1'), true);
  });

  it('returns false for a stable version', () => {
    assert.equal(isPreRelease('1.0.0'), false);
  });
});

// ── satisfiesRequirement ──────────────────────────────────────────────────────

describe('satisfiesRequirement', () => {
  describe('caret default for bare versions', () => {
    it('treats a bare version as a caret requirement', () => {
      assert.equal(satisfiesRequirement('1.5.0', '1.2.3'), true);
      assert.equal(satisfiesRequirement('2.0.0', '1.2.3'), false);
      assert.equal(satisfiesRequirement('1.2.2', '1.2.3'), false);
    });

    it('applies caret 0.x rules where minor is the breaking component', () => {
      assert.equal(satisfiesRequirement('0.2.9', '0.2.3'), true);
      assert.equal(satisfiesRequirement('0.3.0', '0.2.3'), false);
    });
  });

  describe('explicit caret', () => {
    it('honours a leading ^', () => {
      assert.equal(satisfiesRequirement('1.9.0', '^1.2'), true);
      assert.equal(satisfiesRequirement('2.0.0', '^1.2'), false);
    });
  });

  describe('tilde', () => {
    it('restricts to the patch range for ~1.2.3', () => {
      assert.equal(satisfiesRequirement('1.2.9', '~1.2.3'), true);
      assert.equal(satisfiesRequirement('1.3.0', '~1.2.3'), false);
    });

    it('restricts to the minor range for ~1', () => {
      assert.equal(satisfiesRequirement('1.9.0', '~1'), true);
      assert.equal(satisfiesRequirement('2.0.0', '~1'), false);
    });
  });

  describe('wildcards', () => {
    it('bare * matches any version', () => {
      assert.equal(satisfiesRequirement('9.9.9', '*'), true);
    });

    it('1.* matches within the major range', () => {
      assert.equal(satisfiesRequirement('1.9.0', '1.*'), true);
      assert.equal(satisfiesRequirement('2.0.0', '1.*'), false);
    });

    it('1.2.* matches within the minor range', () => {
      assert.equal(satisfiesRequirement('1.2.9', '1.2.*'), true);
      assert.equal(satisfiesRequirement('1.3.0', '1.2.*'), false);
    });
  });

  describe('comma-separated AND', () => {
    it('requires every comparator to match', () => {
      assert.equal(satisfiesRequirement('1.5.0', '>=1.0.0, <2.0.0'), true);
      assert.equal(satisfiesRequirement('2.0.0', '>=1.0.0, <2.0.0'), false);
      assert.equal(satisfiesRequirement('0.9.0', '>=1.0.0, <2.0.0'), false);
    });
  });

  describe('empty and null specs', () => {
    it('matches any version for empty, star, or null spec', () => {
      assert.equal(satisfiesRequirement('1.0.0', ''), true);
      assert.equal(satisfiesRequirement('1.0.0', '*'), true);
      assert.equal(satisfiesRequirement('1.0.0', null), true);
    });
  });
});

// ── resolveVersion ────────────────────────────────────────────────────────────

describe('resolveVersion', () => {
  it('returns unknown latest for an empty version list', () => {
    assert.deepEqual(resolveVersion('1.0', []), { version: 'unknown', isLatest: true });
  });

  it('picks the highest stable version for a null spec', () => {
    const result = resolveVersion(null, ['1.0.0', '1.2.0', '1.1.0']);
    assert.equal(result.version, '1.2.0');
    assert.equal(result.isLatest, true);
  });

  it('prefers stable over pre-release for an any spec', () => {
    const result = resolveVersion('*', ['1.0.0', '1.1.0-beta.1']);
    assert.equal(result.version, '1.0.0');
  });

  it('resolves the highest matching version for a caret-default spec', () => {
    const result = resolveVersion('1.2', ['1.2.0', '1.5.0', '2.0.0']);
    assert.equal(result.version, '1.5.0');
    assert.equal(result.isLatest, false);
  });

  it('marks isLatest true when the resolved version is the newest overall', () => {
    const result = resolveVersion('>=1.0.0', ['1.0.0', '1.5.0']);
    assert.equal(result.version, '1.5.0');
    assert.equal(result.isLatest, true);
  });

  it('falls back to a pre-release when no stable version satisfies', () => {
    const result = resolveVersion('>=1.0.0-alpha, <1.0.0', ['1.0.0-alpha', '1.0.0']);
    assert.equal(result.version, '1.0.0-alpha');
  });

  it('returns null when nothing satisfies the requirement', () => {
    const result = resolveVersion('>=3.0.0', ['1.0.0', '2.0.0']);
    assert.equal(result.version, null);
    assert.equal(result.isLatest, false);
  });
});
