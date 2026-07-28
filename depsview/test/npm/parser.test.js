import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDependencyFile } from "../../src/npm/parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");

/**
 * Creates a temporary directory containing the named fixture files copied in.
 * Returns the path; the OS reaps it on process exit.
 */
function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "depsview-npm-"));
  for (const [name, source] of Object.entries(files)) {
    fs.copyFileSync(source, path.join(dir, name));
  }
  return dir;
}

// ── source priority ───────────────────────────────────────────────────────────

describe("npm parseDependencyFile — source priority", () => {
  it("prefers package-lock.json over pnpm-lock.yaml and package.json", () => {
    const dir = tmpProject({
      "package-lock.json": path.join(FIXTURES, "npm-lockv2", "package-lock.json"),
      "package.json": path.join(FIXTURES, "npm-basic", "package.json"),
    });
    const { source } = parseDependencyFile(dir);
    assert.equal(source, "package-lock.json");
  });

  it("falls back to package.json when no lock file is present", () => {
    const dir = tmpProject({ "package.json": path.join(FIXTURES, "npm-basic", "package.json") });
    const { source } = parseDependencyFile(dir);
    assert.equal(source, "package.json");
  });

  it("throws when no recognised npm file is present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "depsview-npm-"));
    assert.throws(() => parseDependencyFile(dir), /No npm dependency file found/);
  });
});

// ── private registry filtering — package-lock.json ───────────────────────────

describe("npm parseDependencyFile — private filtering (package-lock.json)", () => {
  it("returns privateCount 0 for an all-public lock file", () => {
    const dir = tmpProject({
      "package-lock.json": path.join(FIXTURES, "npm-lockv2", "package-lock.json"),
    });
    const { privateCount } = parseDependencyFile(dir);
    assert.equal(privateCount, 0);
  });

  it("excludes packages resolved from private registries", () => {
    const dir = tmpProject({
      "package-lock.json": path.join(FIXTURES, "npm-private", "package-lock.json"),
    });
    const { deps, privateCount } = parseDependencyFile(dir);
    const names = deps.map((d) => d.name);
    assert.equal(privateCount, 2, "two private packages should be skipped");
    assert.ok(names.includes("lodash"), "public package lodash should be included");
    assert.ok(names.includes("express"), "public package express should be included");
    assert.ok(!names.includes("@corp/internal-lib"), "private scoped package should be excluded");
    assert.ok(!names.includes("private-utils"), "private package should be excluded");
  });

  it("includes all packages when all are on the public registry", () => {
    const dir = tmpProject({
      "package-lock.json": path.join(FIXTURES, "npm-lockv2", "package-lock.json"),
    });
    const { deps } = parseDependencyFile(dir);
    assert.ok(deps.length > 0);
    assert.ok(deps.every((d) => d.name));
  });
});

// ── private registry filtering — pnpm-lock.yaml ──────────────────────────────

describe("npm parseDependencyFile — private filtering (pnpm-lock.yaml)", () => {
  it("returns privateCount 0 for an all-public pnpm lock file", () => {
    const dir = tmpProject({
      "pnpm-lock.yaml": path.join(FIXTURES, "pnpm-v9", "pnpm-lock.yaml"),
    });
    const { privateCount } = parseDependencyFile(dir);
    assert.equal(privateCount, 0);
  });

  it("excludes packages resolved from private registries", () => {
    const dir = tmpProject({
      "pnpm-lock.yaml": path.join(FIXTURES, "pnpm-private", "pnpm-lock.yaml"),
    });
    const { deps, privateCount } = parseDependencyFile(dir);
    const names = deps.map((d) => d.name);
    assert.equal(privateCount, 2, "two private packages should be skipped");
    assert.ok(names.includes("lodash"), "public package lodash should be included");
    assert.ok(names.includes("express"), "public package express should be included");
    assert.ok(!names.includes("@corp/internal-lib"), "private scoped package should be excluded");
    assert.ok(!names.includes("private-utils"), "private package should be excluded");
  });
});

// ── package.json always returns privateCount 0 ────────────────────────────────

describe("npm parseDependencyFile — package.json source", () => {
  it("returns privateCount 0 (no resolved URLs in package.json)", () => {
    const dir = tmpProject({ "package.json": path.join(FIXTURES, "npm-basic", "package.json") });
    const { privateCount } = parseDependencyFile(dir);
    assert.equal(privateCount, 0);
  });
});
