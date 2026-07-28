import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { totalInstalls, parseFormula } from "../../web/src/homebrew/resolver.js";

// ── totalInstalls ─────────────────────────────────────────────────────────────

describe("totalInstalls", () => {
  it("sums all version counts for the given period", () => {
    const analytics = {
      install: {
        "365d": { "wget 1.21.4": 80000, "wget 1.21.3": 20000 },
      },
    };
    assert.equal(totalInstalls(analytics), 100000);
  });

  it("defaults to the 365d period", () => {
    const analytics = {
      install: {
        "30d": { "wget 1.21.4": 5000 },
        "365d": { "wget 1.21.4": 80000 },
      },
    };
    assert.equal(totalInstalls(analytics), 80000);
  });

  it("accepts an explicit period argument", () => {
    const analytics = {
      install: {
        "30d": { "wget 1.21.4": 5000 },
        "365d": { "wget 1.21.4": 80000 },
      },
    };
    assert.equal(totalInstalls(analytics, "30d"), 5000);
  });

  it("returns null when analytics is null", () => {
    assert.equal(totalInstalls(null), null);
  });

  it("returns null when analytics is undefined", () => {
    assert.equal(totalInstalls(undefined), null);
  });

  it("returns null when the period key is missing", () => {
    assert.equal(totalInstalls({ install: {} }, "365d"), null);
  });

  it("returns null when the period object is empty", () => {
    assert.equal(totalInstalls({ install: { "365d": {} } }, "365d"), null);
  });
});

// ── parseFormula ──────────────────────────────────────────────────────────────

describe("parseFormula", () => {
  const baseFormula = {
    name: "wget",
    versions: { stable: "1.21.4" },
    dependencies: ["libidn2", "openssl@3"],
    recommended_dependencies: ["libpsl"],
    build_dependencies: ["pkg-config"],
    optional_dependencies: [],
    analytics: {
      install: { "365d": { "wget 1.21.4": 100000 }, "30d": { "wget 1.21.4": 10000 } },
    },
  };

  it("extracts name and version", () => {
    const pkg = parseFormula(baseFormula);
    assert.equal(pkg.name, "wget");
    assert.equal(pkg.version, "1.21.4");
  });

  it("includes runtime and recommended dependencies by default", () => {
    const pkg = parseFormula(baseFormula);
    assert.deepEqual(pkg.deps.sort(), ["libidn2", "libpsl", "openssl@3"]);
  });

  it("excludes build dependencies by default", () => {
    const pkg = parseFormula(baseFormula);
    assert.ok(!pkg.deps.includes("pkg-config"));
  });

  it("includes build dependencies when includeBuildDeps is true", () => {
    const pkg = parseFormula(baseFormula, { includeBuildDeps: true });
    assert.ok(pkg.deps.includes("pkg-config"));
  });

  it("deduplicates dependencies", () => {
    const formula = {
      ...baseFormula,
      dependencies: ["openssl@3", "openssl@3"],
      recommended_dependencies: ["openssl@3"],
    };
    const pkg = parseFormula(formula);
    assert.equal(pkg.deps.filter((d) => d === "openssl@3").length, 1);
  });

  it("sets installs365 from analytics", () => {
    const pkg = parseFormula(baseFormula);
    assert.equal(pkg.installs365, 100000);
  });

  it("sets installs30 from analytics", () => {
    const pkg = parseFormula(baseFormula);
    assert.equal(pkg.installs30, 10000);
  });

  it("sets the formulae.brew.sh link", () => {
    const pkg = parseFormula(baseFormula);
    assert.equal(pkg.link, "https://formulae.brew.sh/formula/wget");
  });

  it("sets type to formula", () => {
    assert.equal(parseFormula(baseFormula).type, "formula");
  });

  it("includes rubySourcePath from formula data", () => {
    const formula = { ...baseFormula, ruby_source_path: "Formula/w/wget.rb" };
    assert.equal(parseFormula(formula).rubySourcePath, "Formula/w/wget.rb");
  });

  it("sets rubySourcePath to null when absent", () => {
    assert.equal(parseFormula(baseFormula).rubySourcePath, null);
  });

  it('falls back to "unknown" when versions.stable is missing', () => {
    const pkg = parseFormula({ ...baseFormula, versions: {} });
    assert.equal(pkg.version, "unknown");
  });

  it("handles missing optional arrays gracefully", () => {
    const minimal = { name: "foo", versions: { stable: "1.0" } };
    const pkg = parseFormula(minimal);
    assert.deepEqual(pkg.deps, []);
    assert.equal(pkg.installs365, null);
  });

  it("does not mutate the input data object", () => {
    const original = { ...baseFormula, dependencies: ["a", "b"] };
    parseFormula(original);
    assert.deepEqual(original.dependencies, ["a", "b"]);
  });
});
