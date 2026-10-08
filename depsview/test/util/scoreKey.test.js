import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreKey } from "../../src/util/scoreKey.js";
import { scoreKey as reexportedScoreKey } from "../../src/socket/client.js";

describe("scoreKey", () => {
  it("builds an npm key with a lower-cased name", () => {
    assert.equal(scoreKey("npm", "Express", "4.19.2"), "npm:express@4.19.2");
  });

  it("builds a pypi key with a lower-cased name", () => {
    assert.equal(scoreKey("pypi", "PyYAML", "5.3"), "pypi:pyyaml@5.3");
  });

  it("lower-cases every segment of a Go module path", () => {
    assert.equal(
      scoreKey("golang", "github.com/BurntSushi/toml", "v1.3.2"),
      "golang:github.com/burntsushi/toml@v1.3.2",
    );
  });

  it("builds a cargo key", () => {
    assert.equal(scoreKey("cargo", "serde", "1.0.200"), "cargo:serde@1.0.200");
  });

  it("keeps a scoped npm name intact apart from case", () => {
    assert.equal(scoreKey("npm", "@Babel/Core", "7.0.0"), "npm:@babel/core@7.0.0");
  });

  it("does not change the case of the version", () => {
    assert.equal(scoreKey("golang", "x", "v0.0.0-ABC"), "golang:x@v0.0.0-ABC");
  });

  it("does not change the case of the ecosystem", () => {
    assert.equal(scoreKey("NPM", "a", "1.0.0"), "NPM:a@1.0.0");
  });

  it("is the same function re-exported by socket/client.js", () => {
    assert.equal(reexportedScoreKey, scoreKey);
  });
});
