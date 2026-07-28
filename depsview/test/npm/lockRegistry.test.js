import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NPM_LOCK_FILES, NPM_LOCK_FILENAMES } from "../../src/npm/lockRegistry.js";

describe("NPM_LOCK_FILENAMES", () => {
  it("is an instance of Set", () => {
    assert.ok(NPM_LOCK_FILENAMES instanceof Set);
  });

  it("contains package-lock.json", () => {
    assert.ok(NPM_LOCK_FILENAMES.has("package-lock.json"));
  });

  it("contains pnpm-lock.yaml", () => {
    assert.ok(NPM_LOCK_FILENAMES.has("pnpm-lock.yaml"));
  });

  it("contains bun.lock", () => {
    assert.ok(NPM_LOCK_FILENAMES.has("bun.lock"));
  });

  it("contains yarn.lock", () => {
    assert.ok(NPM_LOCK_FILENAMES.has("yarn.lock"));
  });

  it("contains exactly four entries", () => {
    assert.equal(NPM_LOCK_FILENAMES.size, 4);
  });
});

describe("NPM_LOCK_FILES", () => {
  it("has the same number of entries as NPM_LOCK_FILENAMES (no duplicates, no orphans)", () => {
    assert.equal(NPM_LOCK_FILES.length, NPM_LOCK_FILENAMES.size);
  });

  it("lists package-lock.json first (highest priority)", () => {
    assert.equal(NPM_LOCK_FILES[0].filename, "package-lock.json");
  });

  it("lists pnpm-lock.yaml second", () => {
    assert.equal(NPM_LOCK_FILES[1].filename, "pnpm-lock.yaml");
  });

  it("lists bun.lock third", () => {
    assert.equal(NPM_LOCK_FILES[2].filename, "bun.lock");
  });

  it("every entry has a filename string", () => {
    for (const entry of NPM_LOCK_FILES) {
      assert.equal(typeof entry.filename, "string");
    }
  });

  it("every entry has a parse function", () => {
    for (const entry of NPM_LOCK_FILES) {
      assert.equal(typeof entry.parse, "function");
    }
  });

  it("every entry has a getNote function", () => {
    for (const entry of NPM_LOCK_FILES) {
      assert.equal(typeof entry.getNote, "function");
    }
  });
});

describe("NPM_LOCK_FILES — getNote for package-lock.json", () => {
  const entry = NPM_LOCK_FILES.find((e) => e.filename === "package-lock.json");

  it("returns null for any content", () => {
    assert.equal(entry.getNote("{}"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(entry.getNote(""), null);
  });
});

describe("NPM_LOCK_FILES — getNote for bun.lock", () => {
  const entry = NPM_LOCK_FILES.find((e) => e.filename === "bun.lock");

  it("returns null for any content", () => {
    assert.equal(entry.getNote("bun lockfile v0\n"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(entry.getNote(""), null);
  });
});

describe("NPM_LOCK_FILES — getNote for pnpm-lock.yaml", () => {
  const entry = NPM_LOCK_FILES.find((e) => e.filename === "pnpm-lock.yaml");

  it("returns the dev-only warning string for v9 content", () => {
    const v9Content = "lockfileVersion: '9.0'\n\npackages:\n";
    const note = entry.getNote(v9Content);
    assert.equal(typeof note, "string");
    assert.ok(note.length > 0);
    assert.ok(note.includes("dev"));
  });

  it("returns null for v6 content", () => {
    const v6Content = "lockfileVersion: '6.0'\n\npackages:\n";
    assert.equal(entry.getNote(v6Content), null);
  });

  it("returns null for v5 content", () => {
    const v5Content = "lockfileVersion: 5.4\n\npackages:\n";
    assert.equal(entry.getNote(v5Content), null);
  });
});
