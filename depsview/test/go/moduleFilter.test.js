import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPublicGoModule, partitionGoModules } from "../../src/go/moduleFilter.js";

// ── isPublicGoModule ──────────────────────────────────────────────────────────

describe("isPublicGoModule — known public hosts", () => {
  it("returns true for github.com module", () => {
    assert.equal(isPublicGoModule("github.com/gin-gonic/gin"), true);
  });

  it("returns true for gitlab.com module", () => {
    assert.equal(isPublicGoModule("gitlab.com/mygroup/myproject"), true);
  });

  it("returns true for bitbucket.org module", () => {
    assert.equal(isPublicGoModule("bitbucket.org/user/repo"), true);
  });

  it("returns true for golang.org module", () => {
    assert.equal(isPublicGoModule("golang.org/x/crypto"), true);
  });

  it("returns true for gopkg.in module", () => {
    assert.equal(isPublicGoModule("gopkg.in/check.v1"), true);
  });

  it("returns true for k8s.io module", () => {
    assert.equal(isPublicGoModule("k8s.io/client-go"), true);
  });

  it("returns true for sigs.k8s.io module", () => {
    assert.equal(isPublicGoModule("sigs.k8s.io/controller-runtime"), true);
  });

  it("returns true for go.uber.org module", () => {
    assert.equal(isPublicGoModule("go.uber.org/zap"), true);
  });

  it("returns true for google.golang.org module", () => {
    assert.equal(isPublicGoModule("google.golang.org/grpc"), true);
  });

  it("returns true for cloud.google.com module", () => {
    assert.equal(isPublicGoModule("cloud.google.com/go/storage"), true);
  });

  it("returns true for go.opencensus.io module", () => {
    assert.equal(isPublicGoModule("go.opencensus.io"), true);
  });

  it("returns true for go.opentelemetry.io module", () => {
    assert.equal(isPublicGoModule("go.opentelemetry.io/otel"), true);
  });

  it("returns true for go.etcd.io module", () => {
    assert.equal(isPublicGoModule("go.etcd.io/etcd/v3"), true);
  });

  it("returns true for go.mongodb.org module", () => {
    assert.equal(isPublicGoModule("go.mongodb.org/mongo-driver"), true);
  });

  it("returns true for go.temporal.io module", () => {
    assert.equal(isPublicGoModule("go.temporal.io/sdk"), true);
  });

  it("returns true for gocloud.dev module", () => {
    assert.equal(isPublicGoModule("gocloud.dev"), true);
  });

  it("returns true for storj.io module", () => {
    assert.equal(isPublicGoModule("storj.io/drpc"), true);
  });

  it("returns true for mvdan.cc module", () => {
    assert.equal(isPublicGoModule("mvdan.cc/sh/v3"), true);
  });

  it("returns true for honnef.co module", () => {
    assert.equal(isPublicGoModule("honnef.co/go/tools"), true);
  });

  it("returns true for filippo.io module", () => {
    assert.equal(isPublicGoModule("filippo.io/age"), true);
  });

  it("returns true for mellium.im module", () => {
    assert.equal(isPublicGoModule("mellium.im/sasl"), true);
  });

  it("returns true for nhooyr.io module", () => {
    assert.equal(isPublicGoModule("nhooyr.io/websocket"), true);
  });

  it("returns true for cel.dev module", () => {
    assert.equal(isPublicGoModule("cel.dev/expr"), true);
  });

  it("returns true for buf.build module", () => {
    assert.equal(isPublicGoModule("buf.build/gen/go/bufbuild/protovalidate"), true);
  });

  it("returns true for cuelang.org module", () => {
    assert.equal(isPublicGoModule("cuelang.org/go"), true);
  });

  it("returns true for dario.cat module", () => {
    assert.equal(isPublicGoModule("dario.cat/mergo"), true);
  });
});

describe("isPublicGoModule — private / unknown hosts", () => {
  it("returns false for an internal corporate hostname", () => {
    assert.equal(isPublicGoModule("internal.corp.example.invalid/mylib"), false);
  });

  it("returns false for a single-label hostname", () => {
    assert.equal(isPublicGoModule("myrepo/package"), false);
  });

  it("returns false for a module path that looks like a private mirror", () => {
    assert.equal(isPublicGoModule("goproxy.company.invalid/github.com/foo/bar"), false);
  });

  it("returns false for a completely unknown TLD host", () => {
    assert.equal(isPublicGoModule("code.unknown.tld/mypackage"), false);
  });
});

describe("isPublicGoModule — edge cases", () => {
  it("returns false for null", () => {
    assert.equal(isPublicGoModule(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isPublicGoModule(undefined), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isPublicGoModule(""), false);
  });

  it("returns false for a host that is a prefix of a known public host but not an exact match", () => {
    // "github.co" is NOT "github.com"
    assert.equal(isPublicGoModule("github.co/user/repo"), false);
  });

  it("returns true for a module path with no sub-path (host only)", () => {
    assert.equal(isPublicGoModule("github.com"), true);
  });
});

// ── partitionGoModules ────────────────────────────────────────────────────────

describe("partitionGoModules — basic partitioning", () => {
  const modules = [
    { name: "github.com/gin-gonic/gin", version: "v1.9.1", indirect: false },
    { name: "internal.corp.invalid/secret", version: "v1.0.0", indirect: false },
    { name: "golang.org/x/crypto", version: "v0.21.0", indirect: true },
  ];

  it("publicMods contains only the public modules", () => {
    const { publicMods } = partitionGoModules(modules);
    assert.equal(publicMods.length, 2);
    assert.ok(publicMods.find((m) => m.name === "github.com/gin-gonic/gin"));
    assert.ok(publicMods.find((m) => m.name === "golang.org/x/crypto"));
  });

  it("privateCount reflects the number of private modules", () => {
    const { privateCount } = partitionGoModules(modules);
    assert.equal(privateCount, 1);
  });

  it("publicMods entries preserve all original fields including indirect", () => {
    const { publicMods } = partitionGoModules(modules);
    const crypto = publicMods.find((m) => m.name === "golang.org/x/crypto");
    assert.equal(crypto.indirect, true);
    assert.equal(crypto.version, "v0.21.0");
  });

  it("privateMods contains the private module with name and url set to module path", () => {
    const { privateMods } = partitionGoModules(modules);
    assert.equal(privateMods.length, 1);
    assert.equal(privateMods[0].name, "internal.corp.invalid/secret");
    assert.equal(privateMods[0].url, "internal.corp.invalid/secret");
  });

  it("privateMods entries do not contain version or indirect fields", () => {
    const { privateMods } = partitionGoModules(modules);
    assert.equal("version" in privateMods[0], false);
    assert.equal("indirect" in privateMods[0], false);
  });
});

describe("partitionGoModules — empty and all-public inputs", () => {
  it("returns empty publicMods and zero privateCount for empty input", () => {
    const { publicMods, privateCount } = partitionGoModules([]);
    assert.deepEqual(publicMods, []);
    assert.equal(privateCount, 0);
  });

  it("returns empty privateMods for empty input", () => {
    const { privateMods } = partitionGoModules([]);
    assert.deepEqual(privateMods, []);
  });

  it("returns all modules as public when none are private", () => {
    const modules = [
      { name: "github.com/foo/bar", version: "v1.0.0", indirect: false },
      { name: "golang.org/x/net", version: "v0.5.0", indirect: true },
    ];
    const { publicMods, privateCount } = partitionGoModules(modules);
    assert.equal(publicMods.length, 2);
    assert.equal(privateCount, 0);
  });

  it("returns empty privateMods when all modules are public", () => {
    const modules = [
      { name: "github.com/foo/bar", version: "v1.0.0", indirect: false },
      { name: "golang.org/x/net", version: "v0.5.0", indirect: true },
    ];
    const { privateMods } = partitionGoModules(modules);
    assert.deepEqual(privateMods, []);
  });

  it("returns zero publicMods and full count when all are private", () => {
    const modules = [
      { name: "private.invalid/a", version: "v1.0.0", indirect: false },
      { name: "private.invalid/b", version: "v2.0.0", indirect: false },
    ];
    const { publicMods, privateCount } = partitionGoModules(modules);
    assert.deepEqual(publicMods, []);
    assert.equal(privateCount, 2);
  });

  it("privateMods contains all modules with name and url equal to module path when all are private", () => {
    const modules = [
      { name: "private.invalid/a", version: "v1.0.0", indirect: false },
      { name: "private.invalid/b", version: "v2.0.0", indirect: false },
    ];
    const { privateMods } = partitionGoModules(modules);
    assert.equal(privateMods.length, 2);
    assert.equal(privateMods[0].name, "private.invalid/a");
    assert.equal(privateMods[0].url, "private.invalid/a");
    assert.equal(privateMods[1].name, "private.invalid/b");
    assert.equal(privateMods[1].url, "private.invalid/b");
  });
});

describe("partitionGoModules — does not mutate the input array", () => {
  it("leaves the original array unchanged", () => {
    const modules = [{ name: "github.com/foo/bar", version: "v1.0.0", indirect: false }];
    const originalLength = modules.length;
    const originalFirst = { ...modules[0] };
    partitionGoModules(modules);
    assert.equal(modules.length, originalLength);
    assert.deepEqual(modules[0], originalFirst);
  });
});

describe("partitionGoModules — indirect flag handling", () => {
  it("correctly separates direct and indirect public modules into publicMods", () => {
    const modules = [
      { name: "github.com/direct/pkg", version: "v1.0.0", indirect: false },
      { name: "github.com/indirect/pkg", version: "v2.0.0", indirect: true },
    ];
    const { publicMods } = partitionGoModules(modules);
    assert.equal(publicMods.length, 2);
    assert.ok(publicMods.find((m) => m.indirect === false && m.name === "github.com/direct/pkg"));
    assert.ok(publicMods.find((m) => m.indirect === true && m.name === "github.com/indirect/pkg"));
  });

  it("handles modules with no indirect field", () => {
    const modules = [{ name: "github.com/foo/bar", version: "v1.0.0" }];
    const { publicMods, privateCount } = partitionGoModules(modules);
    assert.equal(publicMods.length, 1);
    assert.equal(privateCount, 0);
  });
});
