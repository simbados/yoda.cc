import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchDownloadCounts,
  getDownloadCount,
  _clearCache,
} from "../../src/npm/npmStatsClient.js";

const STATS_BASE = "https://api.npmjs.org/downloads/point/last-month";

let origFetch;
let calls;

beforeEach(() => {
  origFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
  _clearCache();
});

function ok(data) {
  return { ok: true, status: 200, json: async () => data };
}

const notFound = { ok: false, status: 404 };

function setFetch(fn) {
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    return fn(url, opts);
  };
}

describe("getDownloadCount", () => {
  it("returns the integer count from a point entry", () => {
    assert.equal(getDownloadCount({ downloads: 5 }), 5);
  });

  it("floors a fractional count", () => {
    assert.equal(getDownloadCount({ downloads: 5.9 }), 5);
  });

  it("returns 0 for a zero count", () => {
    assert.equal(getDownloadCount({ downloads: 0 }), 0);
  });

  it("returns null for a null entry", () => {
    assert.equal(getDownloadCount(null), null);
  });

  it("returns null for an undefined entry", () => {
    assert.equal(getDownloadCount(undefined), null);
  });

  it("returns null when the downloads field is missing", () => {
    assert.equal(getDownloadCount({}), null);
  });

  it("returns null for a negative count", () => {
    assert.equal(getDownloadCount({ downloads: -1 }), null);
  });

  it("returns null for a non-finite count", () => {
    assert.equal(getDownloadCount({ downloads: Infinity }), null);
  });

  it("returns null for a NaN count", () => {
    assert.equal(getDownloadCount({ downloads: NaN }), null);
  });

  it("returns null when downloads is not a number", () => {
    assert.equal(getDownloadCount({ downloads: "10" }), null);
  });

  it("returns null for a string entry", () => {
    assert.equal(getDownloadCount("nope"), null);
  });

  it("returns null for a number entry", () => {
    assert.equal(getDownloadCount(42), null);
  });
});

describe("fetchDownloadCounts", () => {
  it("sends unscoped names as one comma-joined bulk request", async () => {
    setFetch(() => ok({ react: { downloads: 1 }, vue: { downloads: 2 } }));
    const result = await fetchDownloadCounts(["react", "vue"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${STATS_BASE}/react,vue`);
    assert.equal(result.get("react"), 1);
    assert.equal(result.get("vue"), 2);
  });

  it("maps a bulk miss (null value) to null", async () => {
    setFetch(() => ok({ a: { downloads: 5 }, b: null, c: { downloads: 7 } }));
    const result = await fetchDownloadCounts(["a", "b", "c"]);
    assert.equal(result.get("a"), 5);
    assert.equal(result.get("b"), null);
    assert.equal(result.get("c"), 7);
  });

  it("parses the flat point shape for a single unscoped name", async () => {
    setFetch(() => ok({ downloads: 42, package: "solo" }));
    const result = await fetchDownloadCounts(["solo"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${STATS_BASE}/solo`);
    assert.ok(!calls[0].includes(","));
    assert.equal(result.get("solo"), 42);
  });

  it("records scoped names as null without fetching them and bulk-fetches only the unscoped ones", async () => {
    setFetch(() => ok({ react: { downloads: 1 }, vue: { downloads: 2 } }));
    const result = await fetchDownloadCounts(["react", "@babel/core", "vue", "@types/node"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${STATS_BASE}/react,vue`);
    assert.ok(!calls.some((u) => u.includes("babel")));
    assert.ok(!calls.some((u) => u.includes("types")));
    assert.ok(!calls.some((u) => u.includes("%40")));

    assert.equal(result.get("react"), 1);
    assert.equal(result.get("vue"), 2);
    assert.equal(result.get("@babel/core"), null);
    assert.equal(result.get("@types/node"), null);
  });

  it("makes zero requests and returns name→null when every name is scoped", async () => {
    setFetch(() => ok({}));
    const result = await fetchDownloadCounts(["@babel/core", "@types/node", "@ESBuild/Linux"]);

    assert.equal(calls.length, 0);
    assert.equal(result.size, 3);
    assert.equal(result.get("@babel/core"), null);
    assert.equal(result.get("@types/node"), null);
    assert.equal(result.get("@esbuild/linux"), null);
  });

  it("lowercases result Map keys", async () => {
    setFetch(() => ok({ downloads: 9, package: "react" }));
    const result = await fetchDownloadCounts(["React"]);
    assert.ok(result.has("react"));
    assert.ok(!result.has("React"));
    assert.equal(result.get("react"), 9);
  });

  it("de-duplicates names case-insensitively before fetching", async () => {
    setFetch(() => ok({ downloads: 9, package: "react" }));
    const result = await fetchDownloadCounts(["React", "react", "REACT"]);
    assert.equal(calls.length, 1);
    assert.equal(result.size, 1);
    assert.equal(result.get("react"), 9);
  });

  it("skips empty and non-string names", async () => {
    setFetch(() => ok({ downloads: 4, package: "react" }));
    const result = await fetchDownloadCounts(["react", "", null, undefined, 5]);
    assert.equal(calls.length, 1);
    assert.equal(result.get("react"), 4);
  });

  it("caches counts so a repeated name is not re-fetched", async () => {
    setFetch(() => ok({ downloads: 10, package: "lodash" }));
    const first = await fetchDownloadCounts(["lodash"]);
    const second = await fetchDownloadCounts(["lodash"]);
    assert.equal(calls.length, 1);
    assert.equal(first.get("lodash"), 10);
    assert.equal(second.get("lodash"), 10);
  });

  it("returns null for a name that 404s", async () => {
    setFetch(() => notFound);
    const result = await fetchDownloadCounts(["ghost"]);
    assert.equal(result.get("ghost"), null);
  });

  it("returns null for a name whose request fails on the network", async () => {
    setFetch(() => {
      throw new Error("offline");
    });
    const result = await fetchDownloadCounts(["ghost"]);
    assert.equal(result.get("ghost"), null);
  });

  it("honours a custom https baseUrl override", async () => {
    setFetch(() => ok({ downloads: 12, package: "react" }));
    const result = await fetchDownloadCounts(["react"], { baseUrl: "https://example.test/dl" });
    assert.equal(calls[0], "https://example.test/dl/react");
    assert.equal(result.get("react"), 12);
  });

  it("throws when baseUrl is not https", async () => {
    await assert.rejects(
      () => fetchDownloadCounts(["react"], { baseUrl: "http://insecure.test/dl" }),
      /https/,
    );
  });

  it("returns an empty Map for empty input without fetching", async () => {
    setFetch(() => ok({}));
    const result = await fetchDownloadCounts([]);
    assert.equal(result.size, 0);
    assert.equal(calls.length, 0);
  });
});
