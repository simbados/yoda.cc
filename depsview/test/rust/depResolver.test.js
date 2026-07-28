import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveDependencies } from "../../src/rust/depResolver.js";

/**
 * Builds a minimal Response-shaped object for fetch mocking.
 * @param {number} status
 * @param {object} body
 */
function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("rust resolveDependencies", () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it("resolves an empty input array to an empty Map", async () => {
    const results = await resolveDependencies([]);
    assert.ok(results instanceof Map);
    assert.equal(results.size, 0);
  });

  it("returns lockfile-mode metadata for a crate with an exact version", async () => {
    globalThis.fetch = async () =>
      mockResponse(200, {
        crate: { id: "serde", name: "serde" },
        versions: [
          { num: "1.0.197", created_at: "2024-02-01T00:00:00Z", yanked: false },
          { num: "1.0.0", created_at: "2017-04-20T00:00:00Z", yanked: false },
        ],
      });

    const results = await resolveDependencies([{ name: "serde", version: "1.0.197" }]);
    const r = results.get("serde@1.0.197");
    assert.equal(r.name, "serde");
    assert.equal(r.version, "1.0.197");
    assert.equal(r.releaseDate, "2024-02-01");
    assert.equal(r.firstReleaseDate, "2017-04-20");
    assert.equal(r.releaseCount, 2);
    assert.equal(r.downloadsLastMonth, null);
    assert.equal(r.link, "https://crates.io/crates/serde/1.0.197");
    assert.equal(r.error, undefined);
  });

  it("populates downloadsLastMonth from the crate recent_downloads on the success path", async () => {
    globalThis.fetch = async () =>
      mockResponse(200, {
        crate: { id: "serde", name: "serde", recent_downloads: 233815725 },
        versions: [{ num: "1.0.197", created_at: "2024-02-01T00:00:00Z", yanked: false }],
      });

    const results = await resolveDependencies([{ name: "serde", version: "1.0.197" }]);
    const r = results.get("serde@1.0.197");
    assert.equal(r.downloadsLastMonth, 233815725);
    assert.equal(r.error, undefined);
  });

  it("populates downloadsLastMonth on the no-version-match path", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/dependencies")) return mockResponse(200, { dependencies: [] });
      return mockResponse(200, {
        crate: { id: "serde", name: "serde", recent_downloads: 42 },
        versions: [{ num: "1.0.0", created_at: "2017-04-20T00:00:00Z", yanked: false }],
      });
    };

    const results = await resolveDependencies([{ name: "serde", versionSpec: "99.0.0" }]);
    const r = results.get("serde");
    assert.equal(r.version, "not found");
    assert.ok(r.error.includes("No version matching"));
    assert.equal(r.downloadsLastMonth, 42);
  });

  it("records an error entry when the crate is not found", async () => {
    globalThis.fetch = async () => mockResponse(404, {});

    const results = await resolveDependencies([{ name: "nonexistent", version: "9.9.9" }]);
    const r = results.get("nonexistent@9.9.9");
    assert.equal(r.error, "Crate not found on crates.io");
    assert.equal(r.releaseDate, "unknown");
    assert.equal(r.releaseCount, 0);
    assert.equal(r.downloadsLastMonth, null);
  });
});
