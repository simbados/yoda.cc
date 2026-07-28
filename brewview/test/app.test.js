import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBrewInput } from "../web/app.js";

describe("parseBrewInput", () => {
  describe("comma-separated input", () => {
    it("parses a single formula name", () => {
      assert.deepEqual(parseBrewInput("vim"), ["vim"]);
    });

    it("parses multiple comma-separated names", () => {
      assert.deepEqual(parseBrewInput("vim, ffmpeg, wget"), ["vim", "ffmpeg", "wget"]);
    });

    it("parses comma-separated names without spaces", () => {
      assert.deepEqual(parseBrewInput("vim,ffmpeg,wget"), ["vim", "ffmpeg", "wget"]);
    });

    it("parses comma-separated names with extra surrounding whitespace", () => {
      assert.deepEqual(parseBrewInput("  vim  ,  ffmpeg  "), ["vim", "ffmpeg"]);
    });
  });

  describe("backslash-newline continuation", () => {
    it("joins two names separated by backslash-newline", () => {
      assert.deepEqual(parseBrewInput("vim \\\nffmpeg"), ["vim", "ffmpeg"]);
    });

    it("joins multiple names across several backslash-newline continuations", () => {
      assert.deepEqual(parseBrewInput("vim \\\nffmpeg \\\nwget"), ["vim", "ffmpeg", "wget"]);
    });

    it("handles backslash-newline with indentation on the continuation line", () => {
      assert.deepEqual(parseBrewInput("vim \\\n  ffmpeg"), ["vim", "ffmpeg"]);
    });
  });

  describe("brew outdated format", () => {
    it("extracts the formula name from a brew outdated line", () => {
      assert.deepEqual(parseBrewInput("fzf (0.72.0) < 0.73.0"), ["fzf"]);
    });

    it("extracts a hyphenated formula name from a brew outdated line", () => {
      assert.deepEqual(parseBrewInput("ca-certificates (2026-03-19) < 2026-05-14"), [
        "ca-certificates",
      ]);
    });

    it("extracts the formula name when there is no version suffix", () => {
      assert.deepEqual(parseBrewInput("wget (1.21.3) < 1.21.4"), ["wget"]);
    });
  });

  describe("mixed formats in a single paste", () => {
    it("handles comma-separated and brew outdated lines together", () => {
      const input = "vim, ffmpeg\nfzf (0.72.0) < 0.73.0";
      assert.deepEqual(parseBrewInput(input), ["vim", "ffmpeg", "fzf"]);
    });

    it("handles backslash-newline and brew outdated lines together", () => {
      const input = "vim \\\nffmpeg\nca-certificates (2026-03-19) < 2026-05-14";
      assert.deepEqual(parseBrewInput(input), ["vim", "ffmpeg", "ca-certificates"]);
    });

    it("handles all three formats in a single input", () => {
      const input = "vim, ffmpeg\nwget \\\ngit\nfzf (0.72.0) < 0.73.0";
      assert.deepEqual(parseBrewInput(input), ["vim", "ffmpeg", "wget", "git", "fzf"]);
    });
  });

  describe("deduplication", () => {
    it("deduplicates names appearing twice in comma-separated input", () => {
      assert.deepEqual(parseBrewInput("vim, vim"), ["vim"]);
    });

    it("deduplicates names appearing on separate lines", () => {
      assert.deepEqual(parseBrewInput("vim\nvim"), ["vim"]);
    });

    it("deduplicates names appearing across mixed formats", () => {
      assert.deepEqual(parseBrewInput("vim, ffmpeg\nvim"), ["vim", "ffmpeg"]);
    });

    it("preserves insertion order when deduplicating", () => {
      assert.deepEqual(parseBrewInput("wget, vim, wget, ffmpeg"), ["wget", "vim", "ffmpeg"]);
    });
  });

  describe("empty and whitespace-only input", () => {
    it("returns an empty array for an empty string", () => {
      assert.deepEqual(parseBrewInput(""), []);
    });

    it("returns an empty array for a whitespace-only string", () => {
      assert.deepEqual(parseBrewInput("   "), []);
    });

    it("drops empty lines between valid names", () => {
      assert.deepEqual(parseBrewInput("vim\n\nffmpeg"), ["vim", "ffmpeg"]);
    });

    it("drops lines containing only whitespace between valid names", () => {
      assert.deepEqual(parseBrewInput("vim\n   \nffmpeg"), ["vim", "ffmpeg"]);
    });

    it("drops trailing commas that produce empty tokens", () => {
      assert.deepEqual(parseBrewInput("vim,ffmpeg,"), ["vim", "ffmpeg"]);
    });
  });

  describe("case normalisation", () => {
    it("lowercases an uppercase formula name", () => {
      assert.deepEqual(parseBrewInput("VIM"), ["vim"]);
    });

    it("lowercases mixed-case formula names", () => {
      assert.deepEqual(parseBrewInput("Vim, FFmpeg"), ["vim", "ffmpeg"]);
    });

    it("lowercases names in brew outdated format", () => {
      assert.deepEqual(parseBrewInput("FZF (0.72.0) < 0.73.0"), ["fzf"]);
    });
  });
});
