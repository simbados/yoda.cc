import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseYarnLock,
  getYarnMajorVersion,
  parseClassicSpecifier,
  parseBerrySpecifier,
} from "../../src/npm/yarnLockParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "../fixtures");

function readFixture(name, file) {
  return fs.readFileSync(path.join(fixtures, name, file), "utf8");
}

const classicContent = readFixture("yarn-classic", "yarn.lock");
const berryContent = readFixture("yarn-berry", "yarn.lock");

describe("getYarnMajorVersion", () => {
  it("returns 1 for content containing the classic v1 marker", () => {
    assert.equal(getYarnMajorVersion("# yarn lockfile v1\n\nlodash@^4.0.0:\n"), 1);
  });

  it("returns 2 for content containing __metadata:", () => {
    assert.equal(getYarnMajorVersion("__metadata:\n  version: 6\n"), 2);
  });

  it("returns 1 by default when neither marker is present", () => {
    assert.equal(getYarnMajorVersion("some random content"), 1);
  });

  it("returns 1 for empty string", () => {
    assert.equal(getYarnMajorVersion(""), 1);
  });

  it("returns 1 for the classic fixture", () => {
    assert.equal(getYarnMajorVersion(classicContent), 1);
  });

  it("returns 2 for the berry fixture", () => {
    assert.equal(getYarnMajorVersion(berryContent), 2);
  });
});

describe("parseClassicSpecifier", () => {
  describe("plain package names", () => {
    it("returns the name from a plain specifier like lodash@^4.17.0", () => {
      assert.equal(parseClassicSpecifier("lodash@^4.17.0"), "lodash");
    });

    it("returns the name from a specifier with an exact version", () => {
      assert.equal(parseClassicSpecifier("eslint@8.57.0"), "eslint");
    });
  });

  describe("scoped package names", () => {
    it('returns the scoped name from a quoted specifier like "@babel/core@^7.24.0"', () => {
      assert.equal(parseClassicSpecifier('"@babel/core@^7.24.0"'), "@babel/core");
    });

    it("returns the scoped name from a single-quoted specifier", () => {
      assert.equal(parseClassicSpecifier("'@scope/pkg@^1.0.0'"), "@scope/pkg");
    });

    it("returns the scoped name from an unquoted scoped specifier", () => {
      assert.equal(parseClassicSpecifier("@scope/pkg@^1.0.0"), "@scope/pkg");
    });
  });

  describe("invalid or unresolvable input", () => {
    it("returns null when there is no @ in the string", () => {
      assert.equal(parseClassicSpecifier("nodash"), null);
    });

    it("returns null when the only @ is at position 0 (bare scoped name without version)", () => {
      assert.equal(parseClassicSpecifier("@scope/pkg"), null);
    });

    it("returns null for an empty string", () => {
      assert.equal(parseClassicSpecifier(""), null);
    });

    it("returns null for a quoted bare scoped name with no version", () => {
      assert.equal(parseClassicSpecifier('"@scope/pkg"'), null);
    });
  });
});

describe("parseBerrySpecifier", () => {
  describe("npm protocol", () => {
    it('extracts the scoped name from "@babel/core@npm:^7.24.0"', () => {
      assert.equal(parseBerrySpecifier('"@babel/core@npm:^7.24.0"'), "@babel/core");
    });

    it('extracts a plain name from "lodash@npm:^4.17.0"', () => {
      assert.equal(parseBerrySpecifier('"lodash@npm:^4.17.0"'), "lodash");
    });

    it("extracts the name from an unquoted npm specifier", () => {
      assert.equal(parseBerrySpecifier("lodash@npm:^4.17.0"), "lodash");
    });
  });

  describe("non-@npm: protocols", () => {
    it("returns null for a @workspace: specifier", () => {
      assert.equal(parseBerrySpecifier('"my-app@workspace:."'), null);
    });

    it("returns null for a @file: specifier", () => {
      assert.equal(parseBerrySpecifier('"my-pkg@file:./local"'), null);
    });

    it("returns null for a @patch: specifier", () => {
      assert.equal(parseBerrySpecifier('"pkg@patch:lodash@^4.17.0#./my.patch"'), null);
    });
  });

  describe("edge cases", () => {
    it("returns null when the specifier starts with @npm: (no name before it)", () => {
      assert.equal(parseBerrySpecifier("@npm:^4.17.0"), null);
    });

    it("returns null for an empty string", () => {
      assert.equal(parseBerrySpecifier(""), null);
    });

    it("returns null when there is no @ at all", () => {
      assert.equal(parseBerrySpecifier("justaplainstring"), null);
    });
  });
});

describe("parseYarnLock", () => {
  describe("Classic fixture", () => {
    it("returns exactly 4 packages", () => {
      assert.equal(parseYarnLock(classicContent).length, 4);
    });

    it("includes @babel/core", () => {
      assert.ok(parseYarnLock(classicContent).find((d) => d.name === "@babel/core"));
    });

    it("includes eslint", () => {
      assert.ok(parseYarnLock(classicContent).find((d) => d.name === "eslint"));
    });

    it("includes internal-lib", () => {
      assert.ok(parseYarnLock(classicContent).find((d) => d.name === "internal-lib"));
    });

    it("includes lodash", () => {
      assert.ok(parseYarnLock(classicContent).find((d) => d.name === "lodash"));
    });

    it("deduplicates lodash — multi-specifier header produces exactly one entry", () => {
      assert.equal(parseYarnLock(classicContent).filter((d) => d.name === "lodash").length, 1);
    });

    it("lodash entry has correct version", () => {
      const lodash = parseYarnLock(classicContent).find((d) => d.name === "lodash");
      assert.equal(lodash.version, "4.17.21");
    });

    it("normalises registry.yarnpkg.com to registry.npmjs.org for @babel/core", () => {
      const babel = parseYarnLock(classicContent).find((d) => d.name === "@babel/core");
      assert.ok(babel.resolved.startsWith("https://registry.npmjs.org/"));
    });

    it("strips the #hash from the @babel/core resolved URL", () => {
      const babel = parseYarnLock(classicContent).find((d) => d.name === "@babel/core");
      assert.equal(
        babel.resolved,
        "https://registry.npmjs.org/@babel/core/-/@babel/core-7.24.0.tgz",
      );
    });

    it("strips the #hash from the lodash resolved URL and normalises the host", () => {
      const lodash = parseYarnLock(classicContent).find((d) => d.name === "lodash");
      assert.equal(lodash.resolved, "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    });

    it("keeps the internal-lib resolved URL as-is (non-public registry)", () => {
      const lib = parseYarnLock(classicContent).find((d) => d.name === "internal-lib");
      assert.ok(lib.resolved.startsWith("https://my-company.registry.invalid/"));
    });

    it("internal-lib resolved URL has hash stripped but host preserved", () => {
      const lib = parseYarnLock(classicContent).find((d) => d.name === "internal-lib");
      assert.equal(
        lib.resolved,
        "https://my-company.registry.invalid/internal-lib/-/internal-lib-1.0.0.tgz",
      );
    });

    it("includeTests=true returns the same 4 packages", () => {
      assert.equal(parseYarnLock(classicContent, true).length, 4);
    });

    it("includeTests=false returns the same 4 packages", () => {
      assert.equal(parseYarnLock(classicContent, false).length, 4);
    });

    it("every entry has name, version, and resolved fields", () => {
      for (const dep of parseYarnLock(classicContent)) {
        assert.equal(typeof dep.name, "string");
        assert.equal(typeof dep.version, "string");
        assert.ok("resolved" in dep);
      }
    });
  });

  describe("Berry fixture", () => {
    it("returns exactly 3 packages (workspace entry skipped)", () => {
      assert.equal(parseYarnLock(berryContent).length, 3);
    });

    it("includes @babel/core", () => {
      assert.ok(parseYarnLock(berryContent).find((d) => d.name === "@babel/core"));
    });

    it("includes eslint", () => {
      assert.ok(parseYarnLock(berryContent).find((d) => d.name === "eslint"));
    });

    it("includes lodash", () => {
      assert.ok(parseYarnLock(berryContent).find((d) => d.name === "lodash"));
    });

    it("skips the my-app workspace entry", () => {
      assert.equal(
        parseYarnLock(berryContent).find((d) => d.name === "my-app"),
        undefined,
      );
    });

    it("deduplicates lodash — multi-specifier header produces exactly one entry", () => {
      assert.equal(parseYarnLock(berryContent).filter((d) => d.name === "lodash").length, 1);
    });

    it("lodash entry has correct version", () => {
      const lodash = parseYarnLock(berryContent).find((d) => d.name === "lodash");
      assert.equal(lodash.version, "4.17.21");
    });

    it("all entries have resolved: null (Berry has no tarball URLs)", () => {
      for (const dep of parseYarnLock(berryContent)) {
        assert.equal(dep.resolved, null);
      }
    });

    it("includeTests=true returns the same 3 packages", () => {
      assert.equal(parseYarnLock(berryContent, true).length, 3);
    });

    it("includeTests=false returns the same 3 packages", () => {
      assert.equal(parseYarnLock(berryContent, false).length, 3);
    });
  });

  describe("edge cases — inline strings", () => {
    it("returns empty array for empty string", () => {
      assert.equal(parseYarnLock("").length, 0);
    });

    it("returns empty array for content with only comments", () => {
      const content =
        "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n";
      assert.equal(parseYarnLock(content).length, 0);
    });

    it("returns empty array for content with only blank lines", () => {
      assert.equal(parseYarnLock("\n\n\n").length, 0);
    });

    it("treats content with no markers as Classic and returns empty array for no packages", () => {
      assert.equal(parseYarnLock("some random content\n").length, 0);
    });

    it("Berry: skips linkType: soft entries", () => {
      const content = [
        "__metadata:",
        "  version: 6",
        "",
        '"my-app@workspace:.":',
        "  version: 0.0.0-use.local",
        '  resolution: "my-app@workspace:."',
        "  languageName: unknown",
        "  linkType: soft",
      ].join("\n");
      assert.equal(parseYarnLock(content).length, 0);
    });

    it("Berry: includes linkType: hard entries", () => {
      const content = [
        "__metadata:",
        "  version: 6",
        "",
        '"lodash@npm:^4.17.21":',
        "  version: 4.17.21",
        '  resolution: "lodash@npm:4.17.21"',
        "  languageName: node",
        "  linkType: hard",
      ].join("\n");
      const deps = parseYarnLock(content);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].name, "lodash");
    });

    it("Berry: non-@npm: protocol headers are skipped (@workspace:)", () => {
      const content = [
        "__metadata:",
        "  version: 6",
        "",
        '"my-app@workspace:.":',
        "  version: 0.0.0-use.local",
        "  linkType: hard",
      ].join("\n");
      assert.equal(parseYarnLock(content).length, 0);
    });

    it("Berry: non-@npm: protocol headers are skipped (@file:)", () => {
      const content = [
        "__metadata:",
        "  version: 6",
        "",
        '"local-pkg@file:./local":',
        "  version: 1.0.0",
        "  linkType: hard",
      ].join("\n");
      assert.equal(parseYarnLock(content).length, 0);
    });

    it("Classic: resolved URL with a non-https scheme is stored as null", () => {
      const content = [
        "# yarn lockfile v1",
        "",
        "my-local@^1.0.0:",
        '  version "1.0.0"',
        '  resolved "file:../local-pkg"',
      ].join("\n");
      const deps = parseYarnLock(content);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].resolved, null);
    });

    it("Classic: entry with no resolved field has resolved: null", () => {
      const content = ["# yarn lockfile v1", "", "my-pkg@^1.0.0:", '  version "1.0.0"'].join("\n");
      const deps = parseYarnLock(content);
      assert.equal(deps.length, 1);
      assert.equal(deps[0].resolved, null);
    });
  });
});
