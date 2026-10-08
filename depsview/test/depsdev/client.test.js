import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchDepsDevFindings,
  buildFindingsRequests,
  parseFindingsResponse,
  sanitizeFinding,
  cleanText,
  MAX_BATCH_SIZE,
} from "../../src/depsdev/client.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/depsdev/findingsbatch-response.json", import.meta.url), "utf8"),
);

let origFetch;
let calls;
beforeEach(() => {
  origFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetch(response) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
}

function mockFetchSequence(responses) {
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responses[i++];
  };
}

function entry(system, name, version, findings = {}) {
  return { request: { versionKey: { system, name, version } }, findings };
}

describe("MAX_BATCH_SIZE", () => {
  it("equals the deps.dev hard limit of 5000 requests", () => {
    assert.equal(MAX_BATCH_SIZE, 5000);
  });
});

describe("cleanText", () => {
  it("returns null for a non-string value", () => {
    assert.equal(cleanText(42), null);
    assert.equal(cleanText(null), null);
    assert.equal(cleanText(undefined), null);
    assert.equal(cleanText({}), null);
  });

  it("returns null for an empty or whitespace-only string", () => {
    assert.equal(cleanText(""), null);
    assert.equal(cleanText("   \n\t "), null);
  });

  it("returns null for a string made only of control characters", () => {
    assert.equal(cleanText("\x00\x1b\x7f\x9f"), null);
  });

  it("replaces the ANSI escape character and newlines with spaces", () => {
    assert.equal(cleanText("use \x1b[31mfoo\x1b[0m\ninstead"), "use [31mfoo [0m instead");
  });

  it("strips C1 control characters", () => {
    assert.equal(cleanText("a\u0085b\u009bc"), "a b c");
  });

  it("strips bidi override and isolate characters", () => {
    assert.equal(cleanText("safe\u202eexe.txt\u200e\u200f\u202a\u2066x\u2069"), "safe exe.txt x");
  });

  it("collapses runs of whitespace and trims", () => {
    assert.equal(cleanText("  a   b\t\tc  "), "a b c");
  });

  it("keeps text at exactly the maximum length unchanged", () => {
    const s = "x".repeat(300);
    assert.equal(cleanText(s), s);
  });

  it("truncates text longer than 300 characters to 300 with a trailing ellipsis", () => {
    const out = cleanText("y".repeat(400));
    assert.equal(out.length, 300);
    assert.ok(out.endsWith("…"));
    assert.equal(out.slice(0, 299), "y".repeat(299));
  });

  it("honours a custom max length", () => {
    assert.equal(cleanText("abcdefgh", 5), "abcd…");
  });
});

describe("sanitizeFinding", () => {
  it("returns null for non-object input", () => {
    assert.equal(sanitizeFinding(null), null);
    assert.equal(sanitizeFinding("MALICIOUS"), null);
    assert.equal(sanitizeFinding(7), null);
  });

  it("returns null when type is missing", () => {
    assert.equal(sanitizeFinding({ risk: "RISK_HIGH" }), null);
  });

  it("returns null when type is not an upper-case enum", () => {
    assert.equal(sanitizeFinding({ type: "malicious" }), null);
    assert.equal(sanitizeFinding({ type: "<script>" }), null);
    assert.equal(sanitizeFinding({ type: "A".repeat(41) }), null);
    assert.equal(sanitizeFinding({ type: 1 }), null);
  });

  it("keeps type and risk for a plain finding", () => {
    assert.deepEqual(sanitizeFinding({ type: "VULNERABLE", risk: "RISK_CRITICAL" }), {
      type: "VULNERABLE",
      risk: "RISK_CRITICAL",
    });
  });

  it("sets risk to null when risk is not an upper-case enum", () => {
    assert.deepEqual(sanitizeFinding({ type: "MALICIOUS", risk: "high; rm -rf" }), {
      type: "MALICIOUS",
      risk: null,
    });
  });

  it("sets risk to null when risk is missing", () => {
    assert.deepEqual(sanitizeFinding({ type: "MALICIOUS" }), { type: "MALICIOUS", risk: null });
  });

  it("drops unknown fields", () => {
    const out = sanitizeFinding({
      type: "DEPRECATED",
      risk: "RISK_MEDIUM",
      extra: "x",
      __proto__polluted: true,
      deprecatedContext: { reason: "use padStart", other: 1 },
    });
    assert.deepEqual(out, { type: "DEPRECATED", risk: "RISK_MEDIUM", reason: "use padStart" });
  });

  it("cleans the deprecation reason", () => {
    const out = sanitizeFinding({
      type: "DEPRECATED",
      deprecatedContext: { reason: "bad\x1b[2J\u202etext" },
    });
    assert.equal(out.reason, "bad [2J text");
  });

  it("truncates a long deprecation reason with an ellipsis", () => {
    const out = sanitizeFinding({
      type: "DEPRECATED",
      deprecatedContext: { reason: "r".repeat(1000) },
    });
    assert.equal(out.reason.length, 300);
    assert.ok(out.reason.endsWith("…"));
  });

  it("omits reason when it is not a string", () => {
    const out = sanitizeFinding({ type: "DEPRECATED", deprecatedContext: { reason: 5 } });
    assert.ok(!("reason" in out));
  });

  it("maps cooldownContext.end to until", () => {
    const out = sanitizeFinding({
      type: "COOLDOWN",
      risk: "RISK_HIGH",
      cooldownContext: { end: "2026-10-21T18:35:31Z" },
    });
    assert.deepEqual(out, { type: "COOLDOWN", risk: "RISK_HIGH", until: "2026-10-21T18:35:31Z" });
  });

  it("keeps cleaned alternatives for a LOW_USAGE finding", () => {
    const out = sanitizeFinding({
      type: "LOW_USAGE",
      lowUsageContext: { alternativePackages: ["express", 3, "", "\x1b[31mkoa"] },
    });
    assert.deepEqual(out.alternatives, ["express", "[31mkoa"]);
  });

  it("caps alternatives at 5 entries", () => {
    const out = sanitizeFinding({
      type: "LOW_USAGE",
      lowUsageContext: { alternativePackages: ["a", "b", "c", "d", "e", "f", "g"] },
    });
    assert.deepEqual(out.alternatives, ["a", "b", "c", "d", "e"]);
  });

  it("omits alternatives when none survive cleaning", () => {
    const out = sanitizeFinding({
      type: "LOW_USAGE",
      lowUsageContext: { alternativePackages: [null, " "] },
    });
    assert.ok(!("alternatives" in out));
  });

  it("omits alternatives when alternativePackages is not an array", () => {
    const out = sanitizeFinding({
      type: "LOW_USAGE",
      lowUsageContext: { alternativePackages: "express" },
    });
    assert.ok(!("alternatives" in out));
  });
});

describe("buildFindingsRequests", () => {
  describe("ecosystem mapping", () => {
    it("maps npm, pypi, golang and cargo to deps.dev systems", () => {
      const chunks = buildFindingsRequests([
        { name: "express", version: "4.17.1", ecosystem: "npm" },
        { name: "requests", version: "2.31.0", ecosystem: "pypi" },
        { name: "github.com/gin-gonic/gin", version: "v1.9.1", ecosystem: "golang" },
        { name: "serde", version: "1.0.0", ecosystem: "cargo" },
      ]);
      assert.deepEqual(chunks, [
        [
          { versionKey: { system: "NPM", name: "express", version: "4.17.1" } },
          { versionKey: { system: "PYPI", name: "requests", version: "2.31.0" } },
          { versionKey: { system: "GO", name: "github.com/gin-gonic/gin", version: "v1.9.1" } },
          { versionKey: { system: "CARGO", name: "serde", version: "1.0.0" } },
        ],
      ]);
    });
  });

  describe("skipping", () => {
    it("skips unsupported ecosystems", () => {
      const chunks = buildFindingsRequests([
        { name: "a", version: "1.0.0", ecosystem: "python" },
        { name: "b", version: "1.0.0", ecosystem: "maven" },
        { name: "c", version: "1.0.0", ecosystem: "rust" },
      ]);
      assert.deepEqual(chunks, []);
    });

    it("skips packages with a missing version", () => {
      const chunks = buildFindingsRequests([
        { name: "a", version: "", ecosystem: "npm" },
        { name: "b", version: undefined, ecosystem: "npm" },
        { name: "c", version: null, ecosystem: "npm" },
      ]);
      assert.deepEqual(chunks, []);
    });

    it('skips packages whose version is "unknown"', () => {
      assert.deepEqual(
        buildFindingsRequests([{ name: "a", version: "unknown", ecosystem: "npm" }]),
        [],
      );
    });

    it("skips packages with an empty name", () => {
      assert.deepEqual(
        buildFindingsRequests([{ name: "", version: "1.0.0", ecosystem: "npm" }]),
        [],
      );
    });

    it("returns an empty array for an empty package list", () => {
      assert.deepEqual(buildFindingsRequests([]), []);
    });
  });

  describe("de-duplication", () => {
    it("sends packages differing only in name case once, keeping the first spelling", () => {
      const chunks = buildFindingsRequests([
        { name: "express", version: "4.17.1", ecosystem: "npm" },
        { name: "Express", version: "4.17.1", ecosystem: "npm" },
      ]);
      assert.deepEqual(chunks, [
        [{ versionKey: { system: "NPM", name: "express", version: "4.17.1" } }],
      ]);
    });

    it("keeps the same name with different versions", () => {
      const chunks = buildFindingsRequests([
        { name: "a", version: "1.0.0", ecosystem: "npm" },
        { name: "a", version: "2.0.0", ecosystem: "npm" },
      ]);
      assert.equal(chunks[0].length, 2);
    });

    it("keeps the same name and version in different ecosystems", () => {
      const chunks = buildFindingsRequests([
        { name: "six", version: "1.0.0", ecosystem: "npm" },
        { name: "six", version: "1.0.0", ecosystem: "pypi" },
      ]);
      assert.equal(chunks[0].length, 2);
    });
  });

  describe("chunking", () => {
    it("splits requests into chunks of chunkSize", () => {
      const pkgs = ["a", "b", "c", "d", "e"].map((name) => ({
        name,
        version: "1.0.0",
        ecosystem: "npm",
      }));
      const chunks = buildFindingsRequests(pkgs, 2);
      assert.deepEqual(
        chunks.map((c) => c.map((r) => r.versionKey.name)),
        [["a", "b"], ["c", "d"], ["e"]],
      );
    });

    it("chunks after de-duplication and skipping", () => {
      const chunks = buildFindingsRequests(
        [
          { name: "a", version: "1.0.0", ecosystem: "npm" },
          { name: "A", version: "1.0.0", ecosystem: "npm" },
          { name: "b", version: "unknown", ecosystem: "npm" },
          { name: "c", version: "1.0.0", ecosystem: "npm" },
        ],
        2,
      );
      assert.deepEqual(
        chunks.map((c) => c.length),
        [2],
      );
    });

    it("puts up to MAX_BATCH_SIZE requests in one chunk by default", () => {
      const pkgs = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
        name: `p${i}`,
        version: "1.0.0",
        ecosystem: "npm",
      }));
      const chunks = buildFindingsRequests(pkgs);
      assert.deepEqual(
        chunks.map((c) => c.length),
        [MAX_BATCH_SIZE, 1],
      );
    });
  });

  it("does not mutate the input array", () => {
    const pkgs = [
      { name: "Express", version: "4.17.1", ecosystem: "npm" },
      { name: "express", version: "4.17.1", ecosystem: "npm" },
    ];
    const copy = structuredClone(pkgs);
    buildFindingsRequests(pkgs);
    assert.deepEqual(pkgs, copy);
  });
});

describe("parseFindingsResponse", () => {
  describe("invalid entries", () => {
    it("returns null for null or non-object input", () => {
      assert.equal(parseFindingsResponse(null), null);
      assert.equal(parseFindingsResponse("x"), null);
    });

    it("returns null for a packageKey request", () => {
      assert.equal(
        parseFindingsResponse({
          request: { packageKey: { system: "NPM", name: "reqeusts" } },
          findings: { packageFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }] },
        }),
        null,
      );
    });

    it("returns null for an unknown system", () => {
      assert.equal(parseFindingsResponse(entry("MAVEN", "a", "1.0.0")), null);
    });

    it("returns null when name or version is not a string", () => {
      assert.equal(parseFindingsResponse(entry("NPM", 5, "1.0.0")), null);
      assert.equal(parseFindingsResponse(entry("NPM", "a", null)), null);
    });
  });

  describe("key", () => {
    it("builds the key from the echoed request versionKey, not findings.versionKey", () => {
      const parsed = parseFindingsResponse({
        request: { versionKey: { system: "PYPI", name: "PyYAML", version: "5.3" } },
        findings: {
          versionKey: { system: "PYPI", name: "pyyaml", version: "5.3.0" },
          requestedVersion: { findings: [] },
          packageFindings: [],
        },
      });
      assert.equal(parsed.key, "pypi:pyyaml@5.3");
    });

    it("maps every system back to its purl type", () => {
      assert.equal(parseFindingsResponse(entry("NPM", "a", "1")).key, "npm:a@1");
      assert.equal(parseFindingsResponse(entry("PYPI", "a", "1")).key, "pypi:a@1");
      assert.equal(parseFindingsResponse(entry("GO", "A/b", "v1")).key, "golang:a/b@v1");
      assert.equal(parseFindingsResponse(entry("CARGO", "a", "1")).key, "cargo:a@1");
    });
  });

  describe("record", () => {
    it("records version findings and cooldownEnd when requestedVersion is present", () => {
      const parsed = parseFindingsResponse(
        entry("NPM", "minimist", "0.0.8", {
          requestedVersion: {
            findings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }],
            cooldownEnd: "2014-03-08T04:46:49Z",
          },
          packageFindings: [],
        }),
      );
      assert.deepEqual(parsed.record, {
        versionFound: true,
        versionFindings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }],
        packageFindings: [],
        cooldownEnd: "2014-03-08T04:46:49Z",
        recommended: null,
      });
    });

    it("marks a package-level NOT_FOUND (no requestedVersion) as versionFound false", () => {
      const parsed = parseFindingsResponse(
        entry("NPM", "is-odd-even-checker", "1.0.0", {
          packageFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }],
        }),
      );
      assert.deepEqual(parsed.record, {
        versionFound: false,
        versionFindings: [],
        packageFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }],
        cooldownEnd: null,
        recommended: null,
      });
    });

    it("treats a missing findings object as an empty record", () => {
      const parsed = parseFindingsResponse({
        request: { versionKey: { system: "NPM", name: "a", version: "1.0.0" } },
      });
      assert.deepEqual(parsed.record, {
        versionFound: false,
        versionFindings: [],
        packageFindings: [],
        cooldownEnd: null,
        recommended: null,
      });
    });

    it("takes the first recommended version and its sanitised finding types", () => {
      const parsed = parseFindingsResponse(
        entry("NPM", "axios", "0.21.0", {
          requestedVersion: { findings: [] },
          recommendedVersions: [
            {
              versionKey: { system: "NPM", name: "axios", version: "1.20.0" },
              findings: [{ type: "REMEDIATION", risk: "RISK_INFORMATIONAL" }, { type: "bad" }],
            },
            { versionKey: { system: "NPM", name: "axios", version: "1.19.0" }, findings: [] },
          ],
        }),
      );
      assert.deepEqual(parsed.record.recommended, { version: "1.20.0", types: ["REMEDIATION"] });
    });

    it("sets recommended to null when the first recommendation has no version", () => {
      const parsed = parseFindingsResponse(
        entry("NPM", "a", "1.0.0", { recommendedVersions: [{ findings: [] }] }),
      );
      assert.equal(parsed.record.recommended, null);
    });

    it("drops invalid findings from both lists", () => {
      const parsed = parseFindingsResponse(
        entry("NPM", "a", "1.0.0", {
          requestedVersion: { findings: [{ type: "x" }, null, { type: "MALICIOUS" }] },
          packageFindings: "not-an-array",
        }),
      );
      assert.deepEqual(parsed.record.versionFindings, [{ type: "MALICIOUS", risk: null }]);
      assert.deepEqual(parsed.record.packageFindings, []);
    });
  });
});

describe("fetchDepsDevFindings", () => {
  describe("request", () => {
    it("returns an empty Map without fetching for an empty list", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      const result = await fetchDepsDevFindings([]);
      assert.equal(result.size, 0);
      assert.equal(calls.length, 0);
    });

    it("returns an empty Map without fetching for a non-array argument", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      const result = await fetchDepsDevFindings(null);
      assert.equal(result.size, 0);
      assert.equal(calls.length, 0);
    });

    it("does not fetch when every package is skipped", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      const result = await fetchDepsDevFindings([
        { name: "a", version: "unknown", ecosystem: "npm" },
      ]);
      assert.equal(result.size, 0);
      assert.equal(calls.length, 0);
    });

    it("sends a POST with Content-Type text/plain and a JSON requests body", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      await fetchDepsDevFindings([{ name: "react", version: "19.2.0", ecosystem: "npm" }]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.deps.dev/v3alpha/findingsbatch");
      assert.equal(calls[0].opts.method, "POST");
      assert.equal(calls[0].opts.headers["Content-Type"], "text/plain");
      assert.deepEqual(JSON.parse(calls[0].opts.body), {
        requests: [{ versionKey: { system: "NPM", name: "react", version: "19.2.0" } }],
      });
    });

    it("uses baseUrl when given", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      await fetchDepsDevFindings([{ name: "a", version: "1", ecosystem: "npm" }], {
        baseUrl: "https://proxy.example.invalid/findings",
      });
      assert.equal(calls[0].url, "https://proxy.example.invalid/findings");
    });

    it("sends one POST per MAX_BATCH_SIZE chunk", async () => {
      mockFetch(jsonResponse({ responses: [] }));
      const pkgs = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
        name: `p${i}`,
        version: "1.0.0",
        ecosystem: "npm",
      }));
      await fetchDepsDevFindings(pkgs);
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[0].opts.body).requests.length, MAX_BATCH_SIZE);
      assert.equal(JSON.parse(calls[1].opts.body).requests.length, 1);
    });
  });

  describe("real API fixture", () => {
    it("maps every versionKey response to its echoed request key", async () => {
      mockFetch(jsonResponse(FIXTURE));
      const result = await fetchDepsDevFindings([
        { name: "react", version: "19.2.0", ecosystem: "npm" },
      ]);
      assert.deepEqual([...result.keys()].sort(), [
        "golang:github.com/dgrijalva/jwt-go@v3.2.0+incompatible",
        "npm:axios@0.21.0",
        "npm:next@14.0.0",
        "npm:react@19.2.0",
        "npm:ua-parser-js@0.7.29",
        "pypi:django@3.2.0",
        "pypi:jinja2@2.10",
      ]);
    });

    it("parses a pulled version, a vulnerable version and a deprecation reason", async () => {
      mockFetch(jsonResponse(FIXTURE));
      const result = await fetchDepsDevFindings([
        { name: "react", version: "19.2.0", ecosystem: "npm" },
      ]);
      const ua = result.get("npm:ua-parser-js@0.7.29");
      assert.equal(ua.versionFound, true);
      assert.deepEqual(ua.versionFindings, [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }]);
      assert.deepEqual(ua.recommended, { version: "2.0.10", types: ["REMEDIATION"] });
      assert.deepEqual(result.get("pypi:django@3.2.0").versionFindings, [
        { type: "VULNERABLE", risk: "RISK_CRITICAL" },
      ]);
      assert.match(
        result.get("npm:axios@0.21.0").versionFindings[0].reason,
        /^Critical security vulnerability fixed in v0\.21\.1/,
      );
      assert.equal(result.get("npm:react@19.2.0").cooldownEnd, "2025-10-16T21:38:32Z");
    });
  });

  describe("join", () => {
    it("keys canonicalised responses by the uncanonicalised request", async () => {
      mockFetch(
        jsonResponse({
          responses: [
            {
              request: { versionKey: { system: "PYPI", name: "PyYAML", version: "5.3" } },
              findings: {
                versionKey: { system: "PYPI", name: "pyyaml", version: "5.3.0" },
                requestedVersion: { findings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }] },
                packageFindings: [],
              },
            },
          ],
        }),
      );
      const result = await fetchDepsDevFindings([
        { name: "PyYAML", version: "5.3", ecosystem: "pypi" },
      ]);
      assert.ok(result.has("pypi:pyyaml@5.3"));
      assert.ok(!result.has("pypi:pyyaml@5.3.0"));
    });

    it("keeps the first record when two responses map to the same key", async () => {
      mockFetch(
        jsonResponse({
          responses: [
            entry("NPM", "a", "1.0.0", { requestedVersion: { findings: [{ type: "MALICIOUS" }] } }),
            entry("NPM", "A", "1.0.0", { requestedVersion: { findings: [] } }),
          ],
        }),
      );
      const result = await fetchDepsDevFindings([
        { name: "a", version: "1.0.0", ecosystem: "npm" },
      ]);
      assert.equal(result.size, 1);
      assert.equal(result.get("npm:a@1.0.0").versionFindings[0].type, "MALICIOUS");
    });

    it("records a package-level NOT_FOUND with versionFound false", async () => {
      mockFetch(
        jsonResponse({
          responses: [
            entry("NPM", "reqeusts", "1.0.0", {
              packageFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }],
            }),
          ],
        }),
      );
      const result = await fetchDepsDevFindings([
        { name: "reqeusts", version: "1.0.0", ecosystem: "npm" },
      ]);
      const rec = result.get("npm:reqeusts@1.0.0");
      assert.equal(rec.versionFound, false);
      assert.deepEqual(rec.packageFindings, [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }]);
    });
  });

  describe("pagination", () => {
    it("follows nextPageToken with the same requests plus pageToken", async () => {
      mockFetchSequence([
        jsonResponse({ responses: [entry("NPM", "a", "1.0.0")], nextPageToken: "tok-2" }),
        jsonResponse({ responses: [entry("NPM", "b", "1.0.0")], nextPageToken: "" }),
      ]);
      const pkgs = [
        { name: "a", version: "1.0.0", ecosystem: "npm" },
        { name: "b", version: "1.0.0", ecosystem: "npm" },
      ];
      const result = await fetchDepsDevFindings(pkgs);
      assert.equal(calls.length, 2);
      const first = JSON.parse(calls[0].opts.body);
      const second = JSON.parse(calls[1].opts.body);
      assert.ok(!("pageToken" in first));
      assert.equal(second.pageToken, "tok-2");
      assert.deepEqual(second.requests, first.requests);
      assert.deepEqual([...result.keys()], ["npm:a@1.0.0", "npm:b@1.0.0"]);
    });

    it("stops after maxPages pages even when the API keeps returning tokens", async () => {
      let n = 0;
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        n++;
        return jsonResponse({
          responses: [entry("NPM", `p${n}`, "1.0.0")],
          nextPageToken: `t${n}`,
        });
      };
      const result = await fetchDepsDevFindings([{ name: "a", version: "1", ecosystem: "npm" }], {
        maxPages: 3,
      });
      assert.equal(calls.length, 3);
      assert.equal(result.size, 3);
    });

    it("stops when nextPageToken is not a string", async () => {
      mockFetchSequence([
        jsonResponse({ responses: [entry("NPM", "a", "1.0.0")], nextPageToken: 42 }),
        jsonResponse({ responses: [entry("NPM", "b", "1.0.0")] }),
      ]);
      await fetchDepsDevFindings([{ name: "a", version: "1.0.0", ecosystem: "npm" }]);
      assert.equal(calls.length, 1);
    });

    it("keeps earlier pages when a later page fails", async () => {
      mockFetchSequence([
        jsonResponse({ responses: [entry("NPM", "a", "1.0.0")], nextPageToken: "t" }),
        jsonResponse({}, 500),
      ]);
      const result = await fetchDepsDevFindings(
        [{ name: "a", version: "1.0.0", ecosystem: "npm" }],
        { retryBaseMs: 1 },
      );
      assert.deepEqual([...result.keys()], ["npm:a@1.0.0"]);
    });
  });

  describe("failures", () => {
    const pkgs = [{ name: "a", version: "1.0.0", ecosystem: "npm" }];

    it("returns an empty Map on HTTP 500", async () => {
      mockFetch(jsonResponse({ error: "x" }, 500));
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("returns an empty Map on HTTP 400", async () => {
      mockFetch(jsonResponse({ error: "too many" }, 400));
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("returns an empty Map after repeated HTTP 429", async () => {
      mockFetch(jsonResponse({}, 429));
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
      assert.equal(calls.length, 3);
    });

    it("returns an empty Map when fetch throws", async () => {
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        throw new Error("network down");
      };
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("returns an empty Map when the body has no responses array", async () => {
      mockFetch(jsonResponse({ responses: "nope" }));
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("returns an empty Map when the body is null", async () => {
      mockFetch(jsonResponse(null));
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("returns an empty Map when the body is not valid JSON", async () => {
      mockFetch({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      });
      const result = await fetchDepsDevFindings(pkgs, { retryBaseMs: 1 });
      assert.equal(result.size, 0);
    });

    it("skips malformed entries but keeps valid ones", async () => {
      mockFetch(
        jsonResponse({
          responses: [null, { request: {} }, entry("NPM", "a", "1.0.0"), entry("NOPE", "b", "1")],
        }),
      );
      const result = await fetchDepsDevFindings(pkgs);
      assert.deepEqual([...result.keys()], ["npm:a@1.0.0"]);
    });
  });
});
