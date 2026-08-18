/**
 * Smoke tests for parserCore.js — verifies the module can be imported and that
 * all six exported functions produce correct output without any Node.js imports.
 * These tests mirror the coverage in parser.test.js but import directly from the
 * browser-compatible module so a bad import (e.g. adding node:fs) would fail here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDependencyString,
  parseRequirementsTxtLines,
  parseRequiresDist,
  parsePyprojectToml,
  parseSetupCfg,
  parsePipfile,
  parseManifestJson,
  parsePep508UrlRequirement,
} from "../../src/python/parserCore.js";

// ── parseDependencyString ──────────────────────────────────────────────────────

describe("parseDependencyString", () => {
  it("parses a bare package name", () => {
    assert.deepEqual(parseDependencyString("requests"), { name: "requests", versionSpec: null });
  });

  it("parses a package with a version constraint", () => {
    assert.deepEqual(parseDependencyString("requests>=2.0"), {
      name: "requests",
      versionSpec: ">=2.0",
    });
  });

  it("strips extras", () => {
    assert.deepEqual(parseDependencyString("requests[security]>=2.0"), {
      name: "requests",
      versionSpec: ">=2.0",
    });
  });

  it("strips parenthesised version", () => {
    assert.deepEqual(parseDependencyString("click (>=7.0)"), {
      name: "click",
      versionSpec: ">=7.0",
    });
  });

  it("returns null for a URL", () => {
    assert.equal(parseDependencyString("https://example.invalid/pkg.tar.gz"), null);
  });

  it("returns null for a PEP 508 URL requirement (package @ https://...)", () => {
    assert.equal(parseDependencyString("requests @ https://internal.invalid/requests.whl"), null);
  });

  it("returns null for a PEP 508 URL requirement with a git VCS URL", () => {
    assert.equal(parseDependencyString("mylib @ git+https://github.com/corp/mylib.git@main"), null);
  });

  it("returns null for a PEP 508 URL requirement with a file URL", () => {
    assert.equal(parseDependencyString("mylib @ file:///opt/packages/mylib.whl"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseDependencyString(""), null);
  });
});

// ── parseRequirementsTxtLines ────────────────────────────────────────────────────

describe("parseRequirementsTxtLines", () => {
  it("parses normal name==version dependency lines", () => {
    const content = "requests==2.31.0\nclick>=8.0.0\n";
    const result = parseRequirementsTxtLines(content);
    assert.equal(result.deps.length, 2);
    assert.deepEqual(result.deps[0], { name: "requests", versionSpec: "==2.31.0" });
    assert.deepEqual(result.deps[1], { name: "click", versionSpec: ">=8.0.0" });
  });

  it("parses a bare package name with no version spec", () => {
    const content = "requests\n";
    const result = parseRequirementsTxtLines(content);
    assert.deepEqual(result.deps, [{ name: "requests", versionSpec: null }]);
  });

  it("ignores blank lines and comment lines", () => {
    const content = "\n# a comment\nrequests==2.31.0\n\n";
    const result = parseRequirementsTxtLines(content);
    assert.equal(result.deps.length, 1);
    assert.equal(result.deps[0].name, "requests");
  });

  it("collects a '-r' include line into skippedIncludes instead of following it", () => {
    const content = "requests==2.31.0\n-r other.txt\n";
    const result = parseRequirementsTxtLines(content);
    assert.equal(result.deps.length, 1);
    assert.deepEqual(result.skippedIncludes, ["other.txt"]);
  });

  it("collects a '--requirement' include line into skippedIncludes instead of following it", () => {
    const content = "requests==2.31.0\n--requirement dev-requirements.txt\n";
    const result = parseRequirementsTxtLines(content);
    assert.deepEqual(result.skippedIncludes, ["dev-requirements.txt"]);
  });

  it("collects multiple include lines into skippedIncludes in order", () => {
    const content = "-r base.txt\nrequests==2.31.0\n--requirement dev.txt\n";
    const result = parseRequirementsTxtLines(content);
    assert.deepEqual(result.skippedIncludes, ["base.txt", "dev.txt"]);
  });

  it("skips other '-flag' lines without treating them as includes or deps", () => {
    const content = "-e .\n--index-url https://example.invalid/simple\nrequests==2.31.0\n";
    const result = parseRequirementsTxtLines(content);
    assert.deepEqual(result.deps, [{ name: "requests", versionSpec: "==2.31.0" }]);
    assert.deepEqual(result.skippedIncludes, []);
  });

  it("captures a PEP 508 URL requirement as a dangerous dep instead of a normal dep", () => {
    const content = "internal-auth @ https://artifacts.corp.invalid/internal-auth-1.0.0.whl\n";
    const result = parseRequirementsTxtLines(content);
    assert.equal(result.deps.length, 0);
    assert.equal(result.dangerousDeps.length, 1);
    assert.equal(result.dangerousDeps[0].name, "internal-auth");
    assert.match(result.dangerousDeps[0].reason, /direct URL install/);
  });

  it("does not flag a PyPI-hosted URL requirement as a dangerous dep", () => {
    const content = "requests @ https://files.pythonhosted.org/packages/requests.tar.gz\n";
    const result = parseRequirementsTxtLines(content);
    assert.equal(result.deps.length, 0);
    assert.equal(result.dangerousDeps.length, 0);
  });

  it("returns empty arrays for empty content", () => {
    const result = parseRequirementsTxtLines("");
    assert.deepEqual(result, { deps: [], dangerousDeps: [], skippedIncludes: [] });
  });

  it("strips a trailing backslash line-continuation marker before parsing the line", () => {
    const content = "requests\\\n    ==2.31.0\n";
    const result = parseRequirementsTxtLines(content);
    assert.deepEqual(result.deps, [{ name: "requests", versionSpec: null }]);
  });
});

// ── parseRequiresDist ──────────────────────────────────────────────────────────

describe("parseRequiresDist", () => {
  it("parses a plain dep", () => {
    assert.deepEqual(parseRequiresDist("requests>=2.0"), {
      name: "requests",
      versionSpec: ">=2.0",
    });
  });

  it("skips extras-conditional deps", () => {
    assert.equal(parseRequiresDist('pytest; extra == "test"'), null);
  });

  it("keeps deps with non-extras markers", () => {
    const result = parseRequiresDist('pywin32; sys_platform == "win32"');
    assert.equal(result?.name, "pywin32");
  });
});

// ── parsePyprojectToml ─────────────────────────────────────────────────────────

describe("parsePyprojectToml", () => {
  it("parses PEP 621 [project] dependencies", () => {
    const content = `
[project]
dependencies = [
  "requests>=2.28",
  "click>=8.0",
]
`;
    const deps = parsePyprojectToml(content);
    assert.equal(deps.length, 2);
    assert.equal(deps[0].name, "requests");
    assert.equal(deps[1].name, "click");
  });

  it("parses Poetry [tool.poetry.dependencies]", () => {
    const content = `
[tool.poetry.dependencies]
python = "^3.9"
requests = "^2.28"
click = "^8.0"
`;
    const deps = parsePyprojectToml(content);
    assert.equal(deps.length, 2);
    assert.equal(deps[0].name, "requests");
    assert.equal(deps[1].name, "click");
  });

  it("includes Poetry dev deps when includeTests is true", () => {
    const content = `
[tool.poetry.dependencies]
requests = "^2.28"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
`;
    const deps = parsePyprojectToml(content, true);
    assert.ok(deps.some((d) => d.name === "pytest"));
  });

  it("excludes Poetry dev deps when includeTests is false", () => {
    const content = `
[tool.poetry.dependencies]
requests = "^2.28"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
`;
    const deps = parsePyprojectToml(content, false);
    assert.ok(!deps.some((d) => d.name === "pytest"));
  });
});

// ── parseSetupCfg ──────────────────────────────────────────────────────────────

describe("parseSetupCfg", () => {
  it("parses install_requires", () => {
    const content = `
[options]
install_requires =
    requests>=2.0
    click>=7.0
`;
    const deps = parseSetupCfg(content);
    assert.equal(deps.length, 2);
    assert.equal(deps[0].name, "requests");
    assert.equal(deps[1].name, "click");
  });

  it("returns empty array when no install_requires", () => {
    assert.deepEqual(parseSetupCfg("[metadata]\nname = mypackage\n"), []);
  });
});

// ── parsePipfile ───────────────────────────────────────────────────────────────

describe("parsePipfile", () => {
  it("parses [packages]", () => {
    const content = `
[packages]
requests = ">=2.0"
click = "*"
`;
    const deps = parsePipfile(content);
    assert.equal(deps.length, 2);
    assert.equal(deps[0].name, "requests");
    assert.equal(deps[0].versionSpec, ">=2.0");
    assert.equal(deps[1].versionSpec, null);
  });

  it("includes [dev-packages] when includeTests is true", () => {
    const content = `
[packages]
requests = "*"

[dev-packages]
pytest = "*"
`;
    const deps = parsePipfile(content, true);
    assert.ok(deps.some((d) => d.name === "pytest"));
  });

  it("excludes [dev-packages] when includeTests is false", () => {
    const content = `
[packages]
requests = "*"

[dev-packages]
pytest = "*"
`;
    const deps = parsePipfile(content, false);
    assert.ok(!deps.some((d) => d.name === "pytest"));
  });
});

// ── parsePep508UrlRequirement ──────────────────────────────────────────────────

describe("parsePep508UrlRequirement", () => {
  describe("non-PyPI URL requirements", () => {
    it("returns a non-null result for a package installed from a non-PyPI https URL", () => {
      const result = parsePep508UrlRequirement(
        "requests @ https://evil.example.invalid/requests.tar.gz",
      );
      assert.notEqual(result, null);
    });

    it("returns the package name for a non-PyPI URL requirement", () => {
      const result = parsePep508UrlRequirement(
        "requests @ https://evil.example.invalid/requests.tar.gz",
      );
      assert.equal(result.name, "requests");
    });

    it("returns the full spec string for a non-PyPI URL requirement", () => {
      const result = parsePep508UrlRequirement(
        "requests @ https://evil.example.invalid/requests.tar.gz",
      );
      assert.equal(result.spec, "requests @ https://evil.example.invalid/requests.tar.gz");
    });

    it("includes the hostname in the reason string", () => {
      const result = parsePep508UrlRequirement(
        "requests @ https://evil.example.invalid/requests.tar.gz",
      );
      assert.ok(result.reason.includes("evil.example.invalid"));
    });

    it("returns non-null for an http (non-https) non-PyPI URL", () => {
      const result = parsePep508UrlRequirement(
        "mypkg @ http://internal.company.invalid/mypkg-1.0.tar.gz",
      );
      assert.notEqual(result, null);
      assert.equal(result.name, "mypkg");
    });
  });

  describe("PyPI safe URLs", () => {
    it("returns null for a URL from pypi.org", () => {
      assert.equal(parsePep508UrlRequirement("requests @ https://pypi.org/requests.tar.gz"), null);
    });

    it("returns null for a URL from files.pythonhosted.org", () => {
      assert.equal(
        parsePep508UrlRequirement(
          "requests @ https://files.pythonhosted.org/packages/requests.tar.gz",
        ),
        null,
      );
    });
  });

  describe("non-URL requirement strings", () => {
    it("returns null for a plain version-pinned requirement", () => {
      assert.equal(parsePep508UrlRequirement("requests>=2.0"), null);
    });

    it("returns null for a bare package name with no version", () => {
      assert.equal(parsePep508UrlRequirement("requests"), null);
    });

    it("returns null for an empty string", () => {
      assert.equal(parsePep508UrlRequirement(""), null);
    });

    it("returns null for null input", () => {
      assert.equal(parsePep508UrlRequirement(null), null);
    });

    it("returns null for a package with extras but no URL", () => {
      assert.equal(parsePep508UrlRequirement("requests[security]>=2.0"), null);
    });
  });
});

// ── parseManifestJson ──────────────────────────────────────────────────────────

describe("parseManifestJson", () => {
  it("parses requirements array", () => {
    const content = JSON.stringify({
      domain: "my_integration",
      requirements: ["requests>=2.28", "aiohttp>=3.0"],
    });
    const deps = parseManifestJson(content);
    assert.equal(deps.length, 2);
    assert.equal(deps[0].name, "requests");
    assert.equal(deps[1].name, "aiohttp");
  });

  it("returns empty array when requirements is absent", () => {
    const content = JSON.stringify({ domain: "my_integration" });
    assert.deepEqual(parseManifestJson(content), []);
  });
});
