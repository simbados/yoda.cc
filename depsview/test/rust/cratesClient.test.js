import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCrateInfo,
  getReleaseDate,
  getFirstReleaseDate,
  getReleaseCount,
  getVersionList,
} from '../../src/rust/cratesClient.js';

// ── getReleaseDate ────────────────────────────────────────────────────────────

describe('getReleaseDate', () => {
  const versions = [
    { num: '1.0.0', created_at: '2020-01-05T10:00:00Z' },
    { num: '1.1.0', created_at: '2021-03-15T12:00:00Z' },
  ];

  it('returns the YYYY-MM-DD date for a matching version', () => {
    assert.equal(getReleaseDate(versions, '1.1.0'), '2021-03-15');
  });

  it('returns unknown when the version is not present', () => {
    assert.equal(getReleaseDate(versions, '9.9.9'), 'unknown');
  });

  it('returns unknown when created_at is missing', () => {
    assert.equal(getReleaseDate([{ num: '1.0.0' }], '1.0.0'), 'unknown');
  });

  it('returns unknown when versions is not an array', () => {
    assert.equal(getReleaseDate(null, '1.0.0'), 'unknown');
  });
});

// ── getFirstReleaseDate ───────────────────────────────────────────────────────

describe('getFirstReleaseDate', () => {
  it('returns the earliest created_at regardless of array order', () => {
    const versions = [
      { created_at: '2021-03-15T12:00:00Z' },
      { created_at: '2019-06-01T00:00:00Z' },
      { created_at: '2020-01-05T10:00:00Z' },
    ];
    assert.equal(getFirstReleaseDate(versions), '2019-06-01');
  });

  it('returns unknown for an empty array', () => {
    assert.equal(getFirstReleaseDate([]), 'unknown');
  });

  it('returns unknown when no entry has a created_at', () => {
    assert.equal(getFirstReleaseDate([{ num: '1.0.0' }]), 'unknown');
  });

  it('returns unknown when versions is not an array', () => {
    assert.equal(getFirstReleaseDate(undefined), 'unknown');
  });
});

// ── getReleaseCount ───────────────────────────────────────────────────────────

describe('getReleaseCount', () => {
  it('counts only non-yanked versions', () => {
    const versions = [
      { num: '1.0.0', yanked: false },
      { num: '1.1.0', yanked: true },
      { num: '1.2.0' },
    ];
    assert.equal(getReleaseCount(versions), 2);
  });

  it('returns 0 for an empty array', () => {
    assert.equal(getReleaseCount([]), 0);
  });

  it('returns 0 when versions is not an array', () => {
    assert.equal(getReleaseCount(null), 0);
  });
});

// ── getVersionList ────────────────────────────────────────────────────────────

describe('getVersionList', () => {
  it('returns num strings excluding yanked entries in order', () => {
    const versions = [
      { num: '1.0.0', yanked: false },
      { num: '1.1.0', yanked: true },
      { num: '1.2.0' },
    ];
    assert.deepEqual(getVersionList(versions), ['1.0.0', '1.2.0']);
  });

  it('skips entries without a string num', () => {
    const versions = [{ num: '1.0.0' }, { num: 5 }, { yanked: false }];
    assert.deepEqual(getVersionList(versions), ['1.0.0']);
  });

  it('returns an empty array when versions is not an array', () => {
    assert.deepEqual(getVersionList(null), []);
  });
});

// ── fetchCrateInfo — crate-name validation ────────────────────────────────────

describe('fetchCrateInfo', () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('returns null without fetching for a name with illegal characters', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; };
    const result = await fetchCrateInfo('bad/name');
    assert.equal(result, null);
    assert.equal(fetched, false);
  });

  it('returns null without fetching for a name with a slash or dot', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; };
    assert.equal(await fetchCrateInfo('foo.bar'), null);
    assert.equal(await fetchCrateInfo('../etc/passwd'), null);
    assert.equal(fetched, false);
  });

  it('returns null for an empty crate name', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; };
    assert.equal(await fetchCrateInfo(''), null);
    assert.equal(fetched, false);
  });
});
