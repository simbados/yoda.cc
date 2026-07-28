import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parsePnpmLock,
  parsePnpmDangerousDeps,
  getPnpmMajorVersion,
  parsePackageKey,
  indexOfDepPathSuffix,
  stripPnpmSuffix,
  extractResolutionType,
} from "../../src/npm/pnpmLockParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "../fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(fixtures, name, "pnpm-lock.yaml"), "utf8");
}

describe("parsePnpmLock — v5 lockfile", () => {
  const content = readFixture("pnpm-v5");

  it("returns 2 non-dev packages by default", () => {
    assert.equal(parsePnpmLock(content).length, 2);
  });

  it("includes lodash", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "lodash"));
  });

  it("includes vite", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "vite"));
  });

  it("excludes dev eslint by default", () => {
    assert.ok(!parsePnpmLock(content).find((d) => d.name === "eslint"));
  });

  it("includes eslint with includeTests", () => {
    assert.ok(parsePnpmLock(content, true).find((d) => d.name === "eslint"));
  });

  it("returns exactly 3 packages with includeTests", () => {
    assert.equal(parsePnpmLock(content, true).length, 3);
  });

  it("returns exact versions", () => {
    const lodash = parsePnpmLock(content).find((d) => d.name === "lodash");
    assert.equal(lodash.version, "4.17.21");
  });

  it("all entries have name and version strings", () => {
    for (const dep of parsePnpmLock(content, true)) {
      assert.equal(typeof dep.name, "string");
      assert.equal(typeof dep.version, "string");
    }
  });
});

describe("parsePnpmLock — v6 lockfile", () => {
  const content = readFixture("pnpm-v6");

  it("returns 2 non-dev packages by default", () => {
    assert.equal(parsePnpmLock(content).length, 2);
  });

  it("includes lodash", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "lodash"));
  });

  it("includes vite", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "vite"));
  });

  it("excludes dev eslint by default", () => {
    assert.ok(!parsePnpmLock(content).find((d) => d.name === "eslint"));
  });

  it("includes eslint with includeTests", () => {
    assert.ok(parsePnpmLock(content, true).find((d) => d.name === "eslint"));
  });

  it("returns exact versions", () => {
    const vite = parsePnpmLock(content).find((d) => d.name === "vite");
    assert.equal(vite.version, "5.1.0");
  });
});

describe("parsePnpmLock — v9 lockfile", () => {
  const content = readFixture("pnpm-v9");

  it("returns 2 non-dev packages by default", () => {
    assert.equal(parsePnpmLock(content).length, 2);
  });

  it("includes lodash", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "lodash"));
  });

  it("includes vite", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "vite"));
  });

  it("excludes dev eslint by default (detected from importers section)", () => {
    assert.ok(!parsePnpmLock(content).find((d) => d.name === "eslint"));
  });

  it("includes eslint with includeTests", () => {
    assert.ok(parsePnpmLock(content, true).find((d) => d.name === "eslint"));
  });

  it("returns exact versions", () => {
    const lodash = parsePnpmLock(content).find((d) => d.name === "lodash");
    assert.equal(lodash.version, "4.17.21");
  });

  it("does not include packages from snapshots: section", () => {
    assert.equal(parsePnpmLock(content, true).length, 3);
  });
});

describe("parsePnpmLock — pnpm-private fixture", () => {
  const content = readFixture("pnpm-private");

  it("parses all four packages without error", () => {
    assert.equal(parsePnpmLock(content).length, 4);
  });

  it("preserves the scoped @corp/internal-lib name", () => {
    assert.ok(parsePnpmLock(content).find((d) => d.name === "@corp/internal-lib"));
  });
});

describe("parsePnpmLock — scoped packages (v6)", () => {
  const scopedLock = `lockfileVersion: '6.0'\n\npackages:\n\n  /@babel/core@7.24.0:\n    resolution: {integrity: sha512-xxx}\n    dev: false\n`;

  it("preserves scoped package name", () => {
    const deps = parsePnpmLock(scopedLock);
    assert.ok(deps.find((d) => d.name === "@babel/core"));
  });

  it("returns exact version for scoped package", () => {
    const dep = parsePnpmLock(scopedLock).find((d) => d.name === "@babel/core");
    assert.equal(dep.version, "7.24.0");
  });
});

describe("parsePnpmLock — peer-dep suffix stripped (v9)", () => {
  const peerLock = `lockfileVersion: '9.0'\n\npackages:\n\n  eslint@8.57.0(typescript@5.0.0):\n    resolution: {integrity: sha512-xxx}\n`;

  it("strips peer-dep suffix from version", () => {
    const dep = parsePnpmLock(peerLock, true).find((d) => d.name === "eslint");
    assert.ok(dep, "eslint entry should exist");
    assert.equal(dep.version, "8.57.0");
  });
});

describe("parsePnpmLock — multiple versions (v6)", () => {
  const dupLock = `lockfileVersion: '6.0'\n\npackages:\n\n  /lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n    dev: false\n\n  /lodash@3.10.1:\n    resolution: {integrity: sha512-bbb}\n    dev: false\n`;

  it("returns both versions when they differ", () => {
    const versions = parsePnpmLock(dupLock)
      .filter((d) => d.name === "lodash")
      .map((d) => d.version)
      .sort();
    assert.deepEqual(versions, ["3.10.1", "4.17.21"]);
  });

  it("returns two lodash entries for different versions", () => {
    assert.equal(parsePnpmLock(dupLock).filter((d) => d.name === "lodash").length, 2);
  });
});

describe("parsePnpmLock — empty input", () => {
  it("returns empty array for empty string", () => {
    assert.equal(parsePnpmLock("").length, 0);
  });

  it("returns empty array for lockfile with no packages section", () => {
    assert.equal(parsePnpmLock("lockfileVersion: 5.4\n").length, 0);
  });
});

describe("parsePnpmLock — v9 cross-importer dev classification", () => {
  const crossImporterLock = `lockfileVersion: '9.0'\n\nimporters:\n\n  app-a:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\n  app-b:\n    devDependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n`;

  it("includes lodash when one importer treats it as prod and another as dev", () => {
    const deps = parsePnpmLock(crossImporterLock);
    assert.ok(deps.find((d) => d.name === "lodash"));
  });

  it("returns exactly one lodash entry", () => {
    assert.equal(parsePnpmLock(crossImporterLock).filter((d) => d.name === "lodash").length, 1);
  });
});

describe("parsePnpmLock — v9 optionalDependencies counts as prod", () => {
  const optionalLock = `lockfileVersion: '9.0'\n\nimporters:\n\n  app-a:\n    optionalDependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\n  app-b:\n    devDependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n`;

  it("includes lodash when one importer lists it as optionalDependencies", () => {
    const deps = parsePnpmLock(optionalLock);
    assert.ok(deps.find((d) => d.name === "lodash"));
  });
});

describe("parsePnpmLock — v9 non-tarball resolution routing", () => {
  const directoryLock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n      local-lib:\n        specifier: file:packages/local\n        version: file:packages/local\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n\n  local-lib@file:packages/local:\n    resolution: {directory: packages/local, type: directory}\n`;

  it("excludes directory-resolution entries from deps", () => {
    const deps = parsePnpmLock(directoryLock);
    assert.ok(!deps.find((d) => d.name === "local-lib"));
  });

  it("still includes the normal npm entry alongside a directory entry", () => {
    const deps = parsePnpmLock(directoryLock);
    assert.ok(deps.find((d) => d.name === "lodash"));
  });

  const gitLock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n      forked:\n        specifier: git+ssh://git@github.com/foo/bar.git\n        version: git+ssh://git@github.com/foo/bar.git#abc\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n\n  forked@git+ssh://git@github.com/foo/bar.git#abc:\n    resolution: {commit: abc, repo: 'git+ssh://git@github.com/foo/bar.git', type: git}\n`;

  it("excludes git-resolution entries from deps", () => {
    const deps = parsePnpmLock(gitLock);
    assert.ok(!deps.find((d) => d.name === "forked"));
  });

  it("still returns the normal npm entry when a git entry is present", () => {
    const deps = parsePnpmLock(gitLock);
    assert.ok(deps.find((d) => d.name === "lodash"));
  });
});

describe("indexOfDepPathSuffix", () => {
  describe("no trailing paren", () => {
    it("returns -1 for both indices when input has no trailing )", () => {
      assert.deepEqual(indexOfDepPathSuffix("pkg@1.0.0"), { peersIndex: -1, patchHashIndex: -1 });
    });

    it("returns -1 for both indices for an empty string", () => {
      assert.deepEqual(indexOfDepPathSuffix(""), { peersIndex: -1, patchHashIndex: -1 });
    });
  });

  describe("single peer group", () => {
    it("points peersIndex at the ( before react@ and patchHashIndex at -1", () => {
      const input = "pkg@1.0.0(react@18.0.0)";
      const expected = input.indexOf("(react@");
      const result = indexOfDepPathSuffix(input);
      assert.equal(result.peersIndex, expected);
      assert.equal(result.patchHashIndex, -1);
    });
  });

  describe("multiple peer groups", () => {
    it("points peersIndex at the OUTERMOST ( (not the last one)", () => {
      const input = "pkg@1.0.0(react@18.0.0)(react-dom@18.0.0)";
      const expected = input.indexOf("(react@");
      const result = indexOfDepPathSuffix(input);
      assert.equal(result.peersIndex, expected);
      assert.equal(result.patchHashIndex, -1);
    });

    it("peersIndex is not the lastIndexOf( (regression for v9 multi-peer bug)", () => {
      const input = "pkg@1.0.0(react@18.0.0)(react-dom@18.0.0)";
      const result = indexOfDepPathSuffix(input);
      assert.notEqual(result.peersIndex, input.lastIndexOf("("));
    });
  });

  describe("nested parens inside a peer group", () => {
    it("balances counter correctly and points at the outermost (", () => {
      const input = "pkg@1.0.0(peer@(nested))";
      const expected = input.indexOf("(peer@");
      const result = indexOfDepPathSuffix(input);
      assert.equal(result.peersIndex, expected);
      assert.equal(result.patchHashIndex, -1);
    });
  });

  describe("patch hash without peer", () => {
    it("points patchHashIndex at the ( before patch_hash= and peersIndex at -1", () => {
      const input = "pkg@1.0.0(patch_hash=abc)";
      const expected = input.indexOf("(patch_hash=");
      const result = indexOfDepPathSuffix(input);
      assert.equal(result.patchHashIndex, expected);
      assert.equal(result.peersIndex, -1);
    });
  });

  describe("patch hash followed by peer", () => {
    it("points patchHashIndex at the patch ( and peersIndex at the react (", () => {
      const input = "pkg@1.0.0(patch_hash=abc)(react@18.0.0)";
      const result = indexOfDepPathSuffix(input);
      assert.equal(result.patchHashIndex, input.indexOf("(patch_hash="));
      assert.equal(result.peersIndex, input.indexOf("(react@"));
    });
  });
});

describe("stripPnpmSuffix", () => {
  describe("no suffix", () => {
    it("returns the input unchanged when there is no trailing )", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0"), "pkg@1.0.0");
    });

    it("returns an empty string unchanged", () => {
      assert.equal(stripPnpmSuffix(""), "");
    });
  });

  describe("peer suffix", () => {
    it("removes a single peer group", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0(react@18.0.0)"), "pkg@1.0.0");
    });

    it("removes multiple peer groups starting from the outermost", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0(react@18.0.0)(react-dom@18.0.0)"), "pkg@1.0.0");
    });

    it("removes a peer group containing nested parens", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0(peer@(nested))"), "pkg@1.0.0");
    });
  });

  describe("patch suffix", () => {
    it("removes a patch_hash group when no peer follows", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0(patch_hash=abc)"), "pkg@1.0.0");
    });

    it("removes both patch and peer when both present (patch wins)", () => {
      assert.equal(stripPnpmSuffix("pkg@1.0.0(patch_hash=abc)(react@18.0.0)"), "pkg@1.0.0");
    });
  });
});

describe("extractResolutionType", () => {
  describe("implicit tarball form", () => {
    it("returns null for a typical TarballResolution line", () => {
      assert.equal(
        extractResolutionType(
          "resolution: {integrity: sha512-aaa, tarball: https://example.invalid/x.tgz}",
        ),
        null,
      );
    });

    it("returns null for an integrity-only tarball line", () => {
      assert.equal(extractResolutionType("resolution: {integrity: sha512-aaa}"), null);
    });
  });

  describe("directory", () => {
    it("returns directory for a directory resolution", () => {
      assert.equal(
        extractResolutionType("resolution: {directory: packages/local, type: directory}"),
        "directory",
      );
    });
  });

  describe("git", () => {
    it("returns git for a git resolution", () => {
      assert.equal(
        extractResolutionType(
          "resolution: {commit: abc, repo: 'git+ssh://git@github.com/foo/bar.git', type: git}",
        ),
        "git",
      );
    });
  });

  describe("binary", () => {
    it("returns binary for a binary resolution", () => {
      assert.equal(
        extractResolutionType("resolution: {type: binary, url: https://example.invalid/bin}"),
        "binary",
      );
    });
  });

  describe("custom resolver", () => {
    it("returns the full custom:foo token", () => {
      assert.equal(extractResolutionType("resolution: {type: custom:foo}"), "custom:foo");
    });
  });

  describe("non-resolution input", () => {
    it("returns null when the line does not look like a resolution block", () => {
      assert.equal(extractResolutionType("engines: {node: ^18.0.0}"), null);
    });

    it("returns null for an empty string", () => {
      assert.equal(extractResolutionType(""), null);
    });
  });
});

describe("parsePackageKey", () => {
  describe("v5", () => {
    it("splits a plain key on the last slash", () => {
      assert.deepEqual(parsePackageKey("/lodash/4.17.21", 5), {
        name: "lodash",
        version: "4.17.21",
      });
    });

    it("handles scoped names using lastIndexOf(/)", () => {
      assert.deepEqual(parsePackageKey("/@babel/core/7.24.0", 5), {
        name: "@babel/core",
        version: "7.24.0",
      });
    });

    it("returns null when there is no slash", () => {
      assert.equal(parsePackageKey("lodash-4.17.21", 5), null);
    });
  });

  describe("v6", () => {
    it("splits on indexOf(@,1) so scoped names parse correctly", () => {
      assert.deepEqual(parsePackageKey("/@babel/core@7.24.0", 6), {
        name: "@babel/core",
        version: "7.24.0",
      });
    });

    it("strips a single peer suffix", () => {
      assert.deepEqual(parsePackageKey("/eslint@8.57.0(typescript@5.0.0)", 6), {
        name: "eslint",
        version: "8.57.0",
      });
    });

    it("strips multiple peer suffixes using the outermost-paren walk", () => {
      assert.deepEqual(parsePackageKey("/eslint@8.57.0(typescript@5.0.0)(react@18.0.0)", 6), {
        name: "eslint",
        version: "8.57.0",
      });
    });
  });

  describe("v9", () => {
    it("parses a plain key", () => {
      assert.deepEqual(parsePackageKey("lodash@4.17.21", 9), {
        name: "lodash",
        version: "4.17.21",
      });
    });

    it("parses a scoped name", () => {
      assert.deepEqual(parsePackageKey("@babel/core@7.24.0", 9), {
        name: "@babel/core",
        version: "7.24.0",
      });
    });

    it("returns name and version for a v9 multi-peer scoped key (regression for lastIndexOf bug)", () => {
      assert.deepEqual(
        parsePackageKey("@tanstack/react-query@5.0.0(react@18.0.0)(react-dom@18.0.0)", 9),
        { name: "@tanstack/react-query", version: "5.0.0" },
      );
    });

    it("strips both patch and peer suffixes", () => {
      assert.deepEqual(parsePackageKey("foo@1.0.0(patch_hash=abc)(react@18.0.0)", 9), {
        name: "foo",
        version: "1.0.0",
      });
    });

    it("preserves an npm: alias version with the embedded @", () => {
      assert.deepEqual(parsePackageKey("react-alt@npm:react@18.2.0", 9), {
        name: "react-alt",
        version: "npm:react@18.2.0",
      });
    });

    it("preserves a git+ssh URL with an embedded @", () => {
      assert.deepEqual(parsePackageKey("pkg@git+ssh://git@github.com/foo/bar.git#abc", 9), {
        name: "pkg",
        version: "git+ssh://git@github.com/foo/bar.git#abc",
      });
    });

    it("returns null when name or version is missing", () => {
      assert.equal(parsePackageKey("lodash", 9), null);
    });
  });
});

describe("getPnpmMajorVersion", () => {
  it("reads version 5 from an unquoted lockfileVersion line", () => {
    assert.equal(getPnpmMajorVersion("lockfileVersion: 5.4\n"), 5);
  });

  it("reads version 6 from a quoted lockfileVersion line", () => {
    assert.equal(getPnpmMajorVersion("lockfileVersion: '6.0'\n"), 6);
  });

  it("reads version 9 from a quoted lockfileVersion line", () => {
    assert.equal(getPnpmMajorVersion("lockfileVersion: '9.0'\n"), 9);
  });

  it("defaults to 6 when the field is absent", () => {
    assert.equal(getPnpmMajorVersion("packages:\n"), 6);
  });
});

describe("parsePnpmDangerousDeps", () => {
  describe("directory resolutions", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  local-lib@file:packages/local:\n    resolution: {directory: packages/local, type: directory}\n`;

    it("returns one entry for a directory resolution", () => {
      const out = parsePnpmDangerousDeps(content);
      assert.equal(out.length, 1);
    });

    it("exposes name spec and reason fields", () => {
      const [row] = parsePnpmDangerousDeps(content);
      assert.equal(row.name, "local-lib");
      assert.equal(row.spec, "file:packages/local");
      assert.ok(row.reason.includes("directory"));
    });
  });

  describe("git resolutions", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  forked@git+ssh://git@github.com/foo/bar.git#abc:\n    resolution: {commit: abc, repo: 'git+ssh://git@github.com/foo/bar.git', type: git}\n`;

    it("returns one entry for a git resolution", () => {
      const out = parsePnpmDangerousDeps(content);
      assert.equal(out.length, 1);
    });

    it("the reason mentions git", () => {
      const [row] = parsePnpmDangerousDeps(content);
      assert.equal(row.name, "forked");
      assert.ok(row.reason.includes("git"));
    });
  });

  describe("binary resolutions", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  some-bin@1.0.0:\n    resolution: {type: binary, url: https://example.invalid/bin}\n`;

    it("returns one entry for a binary resolution", () => {
      const out = parsePnpmDangerousDeps(content);
      assert.equal(out.length, 1);
      assert.equal(out[0].name, "some-bin");
      assert.equal(out[0].spec, "1.0.0");
      assert.ok(out[0].reason.includes("binary"));
    });
  });

  describe("custom resolver", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  weird@1.0.0:\n    resolution: {type: custom:foo}\n`;

    it("returns one entry with the custom:foo token in the reason", () => {
      const [row] = parsePnpmDangerousDeps(content);
      assert.equal(row.name, "weird");
      assert.equal(row.spec, "1.0.0");
      assert.ok(row.reason.includes("custom:foo"));
    });
  });

  describe("plain tarball entries", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz}\n`;

    it("returns an empty array for an entry with no resolution.type field", () => {
      assert.deepEqual(parsePnpmDangerousDeps(content), []);
    });
  });

  describe("deduplication", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  local-lib@file:packages/local:\n    resolution: {directory: packages/local, type: directory}\n\n  local-lib@file:packages/local:\n    resolution: {directory: packages/local, type: directory}\n`;

    it("returns a single entry when the same name/spec appears twice", () => {
      assert.equal(parsePnpmDangerousDeps(content).length, 1);
    });
  });

  describe("mixed content", () => {
    const content = `lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-aaa, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz}\n\n  local-lib@file:packages/local:\n    resolution: {directory: packages/local, type: directory}\n\n  forked@git+ssh://git@github.com/foo/bar.git#abc:\n    resolution: {commit: abc, repo: 'git+ssh://git@github.com/foo/bar.git', type: git}\n`;

    it("returns only the non-tarball entries", () => {
      const out = parsePnpmDangerousDeps(content);
      assert.equal(out.length, 2);
      assert.ok(out.find((r) => r.name === "local-lib"));
      assert.ok(out.find((r) => r.name === "forked"));
      assert.ok(!out.find((r) => r.name === "lodash"));
    });
  });

  describe("edge cases", () => {
    it("returns [] for content with no packages: section", () => {
      assert.deepEqual(
        parsePnpmDangerousDeps("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n"),
        [],
      );
    });

    it("returns [] for an empty string", () => {
      assert.deepEqual(parsePnpmDangerousDeps(""), []);
    });

    it("does not throw on invalid YAML-like garbage", () => {
      assert.doesNotThrow(() => parsePnpmDangerousDeps(": : not yaml ::: \n\t???\n"));
      assert.deepEqual(parsePnpmDangerousDeps(": : not yaml ::: \n\t???\n"), []);
    });
  });
});
