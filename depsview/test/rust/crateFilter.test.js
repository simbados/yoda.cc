import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isPublicCratesIo, partitionCargoPackages } from "../../src/rust/crateFilter.js";

// ── isPublicCratesIo ──────────────────────────────────────────────────────────

describe("isPublicCratesIo", () => {
  it("returns true for the registry+ crates.io source", () => {
    assert.equal(isPublicCratesIo("registry+https://github.com/rust-lang/crates.io-index"), true);
  });

  it("returns true for the sparse+ crates.io source", () => {
    assert.equal(isPublicCratesIo("sparse+https://index.crates.io/"), true);
  });

  it("returns false for a git+ source", () => {
    assert.equal(isPublicCratesIo("git+https://github.com/example/foo"), false);
  });

  it("returns false for an alternative registry source", () => {
    assert.equal(isPublicCratesIo("registry+https://registry.corp.invalid/index"), false);
  });

  it("returns false for a non-crates.io sparse source", () => {
    assert.equal(isPublicCratesIo("sparse+https://index.corp.invalid/"), false);
  });

  it("returns false for null", () => {
    assert.equal(isPublicCratesIo(null), false);
  });
});

// ── partitionCargoPackages ────────────────────────────────────────────────────

describe("partitionCargoPackages — basic partitioning", () => {
  const packages = [
    {
      name: "serde",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
    { name: "tokio", version: "1.36.0", source: "sparse+https://index.crates.io/" },
    { name: "internal", version: "0.2.0", source: "git+https://github.com/example/internal" },
    { name: "corp", version: "2.1.0", source: "registry+https://registry.corp.invalid/index" },
    { name: "demo-app", version: "0.1.0", source: null },
  ];

  it("puts registry+ and sparse+ crates.io packages into publicPkgs", () => {
    const { publicPkgs } = partitionCargoPackages(packages);
    const names = publicPkgs.map((p) => p.name).sort();
    assert.deepEqual(names, ["serde", "tokio"]);
  });

  it("puts git+ and alternative registry sources into privatePkgs", () => {
    const { privatePkgs, privateCount } = partitionCargoPackages(packages);
    assert.equal(privateCount, 2);
    const names = privatePkgs.map((p) => p.name).sort();
    assert.deepEqual(names, ["corp", "internal"]);
  });

  it("records the source as the private package url", () => {
    const { privatePkgs } = partitionCargoPackages(packages);
    const internal = privatePkgs.find((p) => p.name === "internal");
    assert.equal(internal.url, "git+https://github.com/example/internal");
  });

  it("silently drops packages with source null", () => {
    const { publicPkgs, privatePkgs } = partitionCargoPackages(packages);
    assert.ok(!publicPkgs.some((p) => p.name === "demo-app"));
    assert.ok(!privatePkgs.some((p) => p.name === "demo-app"));
  });

  it("preserves the version field on public packages", () => {
    const { publicPkgs } = partitionCargoPackages(packages);
    assert.equal(publicPkgs.find((p) => p.name === "tokio").version, "1.36.0");
  });
});

describe("partitionCargoPackages — empty and all-one-bucket inputs", () => {
  it("returns empty buckets for empty input", () => {
    const { publicPkgs, privateCount, privatePkgs } = partitionCargoPackages([]);
    assert.deepEqual(publicPkgs, []);
    assert.equal(privateCount, 0);
    assert.deepEqual(privatePkgs, []);
  });

  it("returns all packages as public when all are crates.io", () => {
    const packages = [
      {
        name: "a",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
      { name: "b", version: "2.0.0", source: "sparse+https://index.crates.io/" },
    ];
    const { publicPkgs, privateCount } = partitionCargoPackages(packages);
    assert.equal(publicPkgs.length, 2);
    assert.equal(privateCount, 0);
  });
});

describe("partitionCargoPackages — does not mutate the input array", () => {
  it("leaves the original array and its elements unchanged", () => {
    const packages = [
      {
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ];
    const originalLength = packages.length;
    const originalFirst = { ...packages[0] };
    partitionCargoPackages(packages);
    assert.equal(packages.length, originalLength);
    assert.deepEqual(packages[0], originalFirst);
  });
});
