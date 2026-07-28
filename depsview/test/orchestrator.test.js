/**
 * Tests for src/orchestrator.js.
 *
 * Covers the small pure helpers and the per-section error isolation that
 * the orchestrator promises. Parse + resolve are exercised end-to-end via
 * the existing CLI smoke test rather than mocked here — those would
 * duplicate the per-ecosystem tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { packagesForSocket } from "../src/orchestrator.js";

// ── packagesForSocket ─────────────────────────────────────────────────────────

describe("packagesForSocket", () => {
  it("flattens results across ecosystems with the PURL ecosystem tag", () => {
    const sections = new Map([
      ["npm", { results: new Map([["express", { name: "express", version: "4.19.2" }]]) }],
      ["python", { results: new Map([["requests", { name: "requests", version: "2.31.0" }]]) }],
      [
        "go",
        {
          results: new Map([
            ["github.com/gin-gonic/gin", { name: "github.com/gin-gonic/gin", version: "v1.9.1" }],
          ]),
        },
      ],
    ]);

    const out = packagesForSocket(sections);
    assert.deepEqual(out, [
      { name: "express", version: "4.19.2", ecosystem: "npm" },
      { name: "requests", version: "2.31.0", ecosystem: "pypi" },
      { name: "github.com/gin-gonic/gin", version: "v1.9.1", ecosystem: "golang" },
    ]);
  });

  it("skips sections that failed entirely", () => {
    const sections = new Map([
      ["npm", { error: "parse failed" }],
      [
        "go",
        {
          results: new Map([
            ["github.com/gin-gonic/gin", { name: "github.com/gin-gonic/gin", version: "v1.9.1" }],
          ]),
        },
      ],
    ]);
    const out = packagesForSocket(sections);
    assert.equal(out.length, 1);
    assert.equal(out[0].ecosystem, "golang");
  });

  it("skips individual packages flagged with an error", () => {
    const sections = new Map([
      [
        "npm",
        {
          results: new Map([
            ["express", { name: "express", version: "4.19.2" }],
            ["broken", { name: "broken", version: "unknown", error: "not found" }],
          ]),
        },
      ],
    ]);
    const out = packagesForSocket(sections);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "express");
  });

  it("returns an empty array when every section failed", () => {
    const sections = new Map([
      ["npm", { error: "a" }],
      ["go", { error: "b" }],
    ]);
    assert.deepEqual(packagesForSocket(sections), []);
  });
});
