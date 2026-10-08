import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFindings,
  depsDevCellText,
  depsDevTooltip,
  depsDevBannerLines,
  depsDevPackageUrl,
  LABELS,
} from "../../src/depsdev/signals.js";

const NOW = new Date("2026-10-08T12:00:00Z");

function rec(overrides = {}) {
  return {
    versionFound: true,
    versionFindings: [],
    packageFindings: [],
    cooldownEnd: null,
    recommended: null,
    ...overrides,
  };
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") deepFreeze(value);
  }
  return Object.freeze(obj);
}

describe("LABELS", () => {
  it("lists every label in descending severity order", () => {
    assert.deepEqual(
      LABELS.map((l) => l.label),
      ["malicious", "pulled", "vulnerable", "low usage", "deprecated", "new", "unknown", "ok"],
    );
    assert.deepEqual(
      LABELS.map((l) => l.severity),
      [7, 6, 5, 4, 3, 2, 1, 0],
    );
  });

  it("assigns the expected colour band to every label", () => {
    assert.deepEqual(Object.fromEntries(LABELS.map((l) => [l.label, l.color])), {
      malicious: "red",
      pulled: "red",
      vulnerable: "orange",
      "low usage": "orange",
      deprecated: "yellow",
      new: "yellow",
      unknown: "yellow",
      ok: "green",
    });
  });
});

describe("classifyFindings", () => {
  describe("missing record", () => {
    it("returns null for a null record", () => {
      assert.equal(classifyFindings(null, "1.0.0", NOW), null);
    });

    it("returns null for an undefined record", () => {
      assert.equal(classifyFindings(undefined, "1.0.0", NOW), null);
    });

    it("returns null for a non-object record", () => {
      assert.equal(classifyFindings("x", "1.0.0", NOW), null);
    });
  });

  describe("single labels", () => {
    it("labels a version-level MALICIOUS finding as malicious in red", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "MALICIOUS", risk: "RISK_CRITICAL" }] }),
        "1.0.0",
        NOW,
      );
      assert.equal(c.label, "malicious");
      assert.equal(c.color, "red");
      assert.equal(c.severity, 7);
      assert.equal(c.count, 1);
      assert.deepEqual(c.details, [
        "Flagged as malicious (OSSF Malicious Packages). Do not install.",
      ]);
    });

    it("labels a package-level MALICIOUS finding as malicious", () => {
      const c = classifyFindings(rec({ packageFindings: [{ type: "MALICIOUS" }] }), "1.0.0", NOW);
      assert.equal(c.label, "malicious");
    });

    it("labels a version NOT_FOUND on an existing package as pulled in red", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }] }),
        "0.7.29",
        NOW,
      );
      assert.equal(c.label, "pulled");
      assert.equal(c.color, "red");
      assert.equal(c.severity, 6);
      assert.deepEqual(c.details, [
        "This version is no longer in the registry — often removed after a compromise.",
      ]);
    });

    it("labels a VULNERABLE finding as vulnerable in orange", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "VULNERABLE", risk: "RISK_CRITICAL" }] }),
        "3.2.0",
        NOW,
      );
      assert.equal(c.label, "vulnerable");
      assert.equal(c.color, "orange");
      assert.deepEqual(c.details, ["Affected by a critical vulnerability."]);
    });

    it("labels a package-level VULNERABLE finding as vulnerable", () => {
      const c = classifyFindings(rec({ packageFindings: [{ type: "VULNERABLE" }] }), "1", NOW);
      assert.equal(c.label, "vulnerable");
    });

    it("labels LOW_USAGE with alternatives as low usage with a did-you-mean hint", () => {
      const c = classifyFindings(
        rec({ packageFindings: [{ type: "LOW_USAGE", alternatives: ["express", "koa"] }] }),
        "1.0.0",
        NOW,
      );
      assert.equal(c.label, "low usage");
      assert.equal(c.color, "orange");
      assert.deepEqual(c.details, ["Very low usage. Did you mean: express, koa?"]);
    });

    it("labels LOW_USAGE without alternatives with a double-check hint", () => {
      const c = classifyFindings(rec({ packageFindings: [{ type: "LOW_USAGE" }] }), "1", NOW);
      assert.equal(c.label, "low usage");
      assert.deepEqual(c.details, ["Very low usage — double-check the package name."]);
    });

    it("labels LOW_USAGE with an empty alternatives array with a double-check hint", () => {
      const c = classifyFindings(
        rec({ packageFindings: [{ type: "LOW_USAGE", alternatives: [] }] }),
        "1",
        NOW,
      );
      assert.deepEqual(c.details, ["Very low usage — double-check the package name."]);
    });

    it("labels DEPRECATED with a reason as deprecated in yellow", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "DEPRECATED", reason: "use padStart" }] }),
        "1.3.0",
        NOW,
      );
      assert.equal(c.label, "deprecated");
      assert.equal(c.color, "yellow");
      assert.deepEqual(c.details, ["Deprecated: use padStart"]);
    });

    it("labels DEPRECATED without a reason as deprecated", () => {
      const c = classifyFindings(rec({ packageFindings: [{ type: "DEPRECATED" }] }), "1", NOW);
      assert.equal(c.label, "deprecated");
      assert.deepEqual(c.details, ["Deprecated."]);
    });

    it("prefers a DEPRECATED finding that carries a reason", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [{ type: "DEPRECATED" }],
          packageFindings: [{ type: "DEPRECATED", reason: "moved to @scope/pkg" }],
        }),
        "1",
        NOW,
      );
      assert.deepEqual(c.details, ["Deprecated: moved to @scope/pkg"]);
    });

    it("labels a version COOLDOWN finding as new with its end date", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "COOLDOWN", until: "2026-10-21T18:35:31Z" }] }),
        "16.4.0",
        NOW,
      );
      assert.equal(c.label, "new");
      assert.equal(c.color, "yellow");
      assert.deepEqual(c.details, ["Released recently — in cooldown until 2026-10-21."]);
    });

    it("labels a COOLDOWN finding as new even when its end date is in the past", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "COOLDOWN", until: "2020-01-01T00:00:00Z" }] }),
        "1",
        NOW,
      );
      assert.equal(c.label, "new");
    });

    it("labels a COOLDOWN finding without any end date as new", () => {
      const c = classifyFindings(rec({ versionFindings: [{ type: "COOLDOWN" }] }), "1", NOW);
      assert.equal(c.label, "new");
      assert.deepEqual(c.details, ["Released recently — in cooldown."]);
    });

    it("uses the record cooldownEnd for the date when the COOLDOWN finding has none", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "COOLDOWN" }], cooldownEnd: "2026-10-12T15:24:49Z" }),
        "1",
        NOW,
      );
      assert.deepEqual(c.details, ["Released recently — in cooldown until 2026-10-12."]);
    });

    it("labels a future cooldownEnd as new relative to the injected now", () => {
      const c = classifyFindings(rec({ cooldownEnd: "2026-10-09T00:00:00Z" }), "1", NOW);
      assert.equal(c.label, "new");
      assert.deepEqual(c.details, ["Released recently — in cooldown until 2026-10-09."]);
    });

    it("does not label a past cooldownEnd as new", () => {
      const c = classifyFindings(rec({ cooldownEnd: "2026-10-01T00:00:00Z" }), "1", NOW);
      assert.equal(c.label, "ok");
    });

    it("does not label a cooldownEnd equal to now as new", () => {
      const c = classifyFindings(rec({ cooldownEnd: NOW.toISOString() }), "1", NOW);
      assert.equal(c.label, "ok");
    });

    it("ignores an unparseable cooldownEnd", () => {
      const c = classifyFindings(rec({ cooldownEnd: "not-a-date" }), "1", NOW);
      assert.equal(c.label, "ok");
    });

    it("ignores cooldownEnd on a package-level COOLDOWN finding", () => {
      const c = classifyFindings(rec({ packageFindings: [{ type: "COOLDOWN" }] }), "1", NOW);
      assert.equal(c.label, "ok");
    });

    it("labels a package-level NOT_FOUND as unknown in yellow", () => {
      const c = classifyFindings(
        rec({
          versionFound: false,
          packageFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }],
        }),
        "1.0.0",
        NOW,
      );
      assert.equal(c.label, "unknown");
      assert.equal(c.color, "yellow");
      assert.equal(c.severity, 1);
      assert.deepEqual(c.details, ["Not known to deps.dev (typo, very new, or private name?)."]);
    });

    it("labels a record without findings as ok in green", () => {
      const c = classifyFindings(rec(), "19.2.0", NOW);
      assert.deepEqual(c, {
        label: "ok",
        color: "green",
        severity: 0,
        count: 1,
        labels: ["ok"],
        details: ["No known issues found by deps.dev (this is not a guarantee)."],
        recommended: null,
        recommendedFixesVulnerability: false,
      });
    });

    it("treats non-array finding lists as empty", () => {
      const c = classifyFindings(
        { versionFound: true, versionFindings: "x", packageFindings: null },
        "1",
        NOW,
      );
      assert.equal(c.label, "ok");
    });
  });

  describe("package NOT_FOUND vs pulled", () => {
    it("does not produce pulled when the whole package is NOT_FOUND", () => {
      const c = classifyFindings(
        rec({
          versionFound: true,
          versionFindings: [{ type: "NOT_FOUND" }],
          packageFindings: [{ type: "NOT_FOUND" }],
        }),
        "1.0.0",
        NOW,
      );
      assert.deepEqual(c.labels, ["unknown"]);
    });
  });

  describe("ignored findings", () => {
    it("ignores unknown finding types", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "SOMETHING_NEW" }], packageFindings: [{ type: "FOO" }] }),
        "1",
        NOW,
      );
      assert.equal(c.label, "ok");
    });

    it("ignores REMEDIATION on the installed version", () => {
      const c = classifyFindings(
        rec({ versionFindings: [{ type: "REMEDIATION", risk: "RISK_INFORMATIONAL" }] }),
        "1",
        NOW,
      );
      assert.equal(c.label, "ok");
    });
  });

  describe("multiple labels", () => {
    it("shows the worst label, counts distinct labels and orders details by severity", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [
            { type: "DEPRECATED", reason: "upgrade" },
            { type: "VULNERABLE", risk: "RISK_CRITICAL" },
          ],
        }),
        "14.0.0",
        NOW,
      );
      assert.equal(c.label, "vulnerable");
      assert.equal(c.color, "orange");
      assert.equal(c.count, 2);
      assert.deepEqual(c.labels, ["vulnerable", "deprecated"]);
      assert.deepEqual(c.details, ["Affected by a critical vulnerability.", "Deprecated: upgrade"]);
    });

    it("counts a label once even when several findings map to it", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [{ type: "VULNERABLE" }],
          packageFindings: [{ type: "VULNERABLE" }],
        }),
        "1",
        NOW,
      );
      assert.equal(c.count, 1);
    });

    it("labels malicious plus version NOT_FOUND as malicious with count 2", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [{ type: "NOT_FOUND", risk: "RISK_CRITICAL" }],
          packageFindings: [{ type: "MALICIOUS", risk: "RISK_CRITICAL" }],
        }),
        "1.0.0",
        NOW,
      );
      assert.equal(c.label, "malicious");
      assert.equal(c.count, 2);
      assert.deepEqual(c.labels, ["malicious", "pulled"]);
    });

    it("sorts every label by severity when all apply", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [
            { type: "COOLDOWN" },
            { type: "DEPRECATED" },
            { type: "LOW_USAGE" },
            { type: "VULNERABLE" },
            { type: "NOT_FOUND" },
            { type: "MALICIOUS" },
          ],
        }),
        "1",
        NOW,
      );
      assert.deepEqual(c.labels, [
        "malicious",
        "pulled",
        "vulnerable",
        "low usage",
        "deprecated",
        "new",
      ]);
      assert.equal(c.count, 6);
      assert.equal(c.details.length, 6);
    });

    it("does not add ok when another label is present", () => {
      const c = classifyFindings(rec({ versionFindings: [{ type: "DEPRECATED" }] }), "1", NOW);
      assert.ok(!c.labels.includes("ok"));
    });
  });

  describe("recommended", () => {
    it("returns the recommended version when it differs from the installed one", () => {
      const c = classifyFindings(
        rec({ recommended: { version: "1.20.0", types: [] } }),
        "0.21.0",
        NOW,
      );
      assert.equal(c.recommended, "1.20.0");
      assert.equal(c.recommendedFixesVulnerability, false);
    });

    it("hides the recommended version when it equals the installed version", () => {
      const c = classifyFindings(
        rec({ recommended: { version: "v3.2.0+incompatible", types: ["REMEDIATION"] } }),
        "v3.2.0+incompatible",
        NOW,
      );
      assert.equal(c.recommended, null);
      assert.equal(c.recommendedFixesVulnerability, false);
    });

    it("sets recommendedFixesVulnerability when the recommendation is a REMEDIATION", () => {
      const c = classifyFindings(
        rec({
          versionFindings: [{ type: "VULNERABLE" }],
          recommended: { version: "1.2.0", types: ["REMEDIATION"] },
        }),
        "1.0.0",
        NOW,
      );
      assert.equal(c.recommended, "1.2.0");
      assert.equal(c.recommendedFixesVulnerability, true);
    });

    it("tolerates a recommendation without types", () => {
      const c = classifyFindings(rec({ recommended: { version: "2.0.0" } }), "1.0.0", NOW);
      assert.equal(c.recommended, "2.0.0");
      assert.equal(c.recommendedFixesVulnerability, false);
    });
  });

  describe("immutability", () => {
    it("does not mutate a deep-frozen record", () => {
      const record = deepFreeze(
        rec({
          versionFindings: [{ type: "DEPRECATED", reason: "x" }, { type: "NOT_FOUND" }],
          packageFindings: [{ type: "MALICIOUS" }, { type: "LOW_USAGE", alternatives: ["a"] }],
          cooldownEnd: "2030-01-01T00:00:00Z",
          recommended: { version: "2.0.0", types: ["REMEDIATION"] },
        }),
      );
      const snapshot = structuredClone(record);
      assert.doesNotThrow(() => classifyFindings(record, "1.0.0", NOW));
      assert.deepEqual(record, snapshot);
    });

    it("returns a details array independent of the input", () => {
      const record = rec({ packageFindings: [{ type: "LOW_USAGE", alternatives: ["a", "b"] }] });
      const c = classifyFindings(record, "1", NOW);
      c.details.push("x");
      assert.deepEqual(record.packageFindings[0].alternatives, ["a", "b"]);
    });
  });
});

describe("depsDevCellText", () => {
  it('returns "-" for a null classification', () => {
    assert.equal(depsDevCellText(null), "-");
  });

  it("returns the custom empty text for a null classification", () => {
    assert.equal(depsDevCellText(null, "–"), "–");
  });

  it("returns just the label when there is one label", () => {
    assert.equal(depsDevCellText({ label: "ok", count: 1 }), "ok");
  });

  it('appends "+N" for the additional labels', () => {
    assert.equal(depsDevCellText({ label: "vulnerable", count: 2 }), "vulnerable +1");
    assert.equal(depsDevCellText({ label: "malicious", count: 4 }), "malicious +3");
  });

  it("formats the lodahs classification as malicious +1", () => {
    const c = classifyFindings(
      rec({ versionFindings: [{ type: "NOT_FOUND" }], packageFindings: [{ type: "MALICIOUS" }] }),
      "1.0.0",
      NOW,
    );
    assert.equal(depsDevCellText(c), "malicious +1");
  });
});

describe("depsDevTooltip", () => {
  it("returns an empty string for a null classification", () => {
    assert.equal(depsDevTooltip(null), "");
  });

  it("joins details with newlines", () => {
    assert.equal(
      depsDevTooltip({
        details: ["a", "b"],
        recommended: null,
        recommendedFixesVulnerability: false,
      }),
      "a\nb",
    );
  });

  it("appends the recommended version", () => {
    assert.equal(
      depsDevTooltip({
        details: ["a"],
        recommended: "2.0.0",
        recommendedFixesVulnerability: false,
      }),
      "a\nRecommended: 2.0.0",
    );
  });

  it("marks a recommendation that fixes a vulnerability", () => {
    assert.equal(
      depsDevTooltip({
        details: ["Affected by a critical vulnerability."],
        recommended: "1.2.0",
        recommendedFixesVulnerability: true,
      }),
      "Affected by a critical vulnerability.\nRecommended: 1.2.0 (fixes a known vulnerability)",
    );
  });

  it("does not mutate the details array", () => {
    const details = Object.freeze(["a"]);
    assert.doesNotThrow(() =>
      depsDevTooltip({ details, recommended: "2", recommendedFixesVulnerability: false }),
    );
  });
});

describe("depsDevBannerLines", () => {
  it("returns an empty array when no rows are malicious or pulled", () => {
    assert.deepEqual(
      depsDevBannerLines([
        { name: "a", version: "1", depsDev: { labels: ["vulnerable"] } },
        { name: "b", version: "1", depsDev: null },
        { name: "c", version: "1" },
      ]),
      [],
    );
  });

  it("returns an empty array for no rows", () => {
    assert.deepEqual(depsDevBannerLines([]), []);
  });

  it("returns one singular line for one malicious package", () => {
    assert.deepEqual(
      depsDevBannerLines([
        { name: "lodahs", version: "1.0.0", depsDev: { labels: ["malicious"] } },
      ]),
      [
        "⚠ 1 package is flagged as malicious: lodahs@1.0.0. Do not install it — remove it from your dependencies.",
      ],
    );
  });

  it("returns one singular line for one pulled version", () => {
    assert.deepEqual(
      depsDevBannerLines([
        { name: "ua-parser-js", version: "0.7.29", depsDev: { labels: ["pulled"] } },
      ]),
      [
        "⚠ 1 locked version was pulled from the registry (often after a compromise): ua-parser-js@0.7.29. Upgrade or remove it.",
      ],
    );
  });

  it("uses plural wording for several malicious and several pulled packages", () => {
    assert.deepEqual(
      depsDevBannerLines([
        { name: "a", version: "1", depsDev: { labels: ["malicious"] } },
        { name: "b", version: "2", depsDev: { labels: ["malicious", "deprecated"] } },
        { name: "c", version: "3", depsDev: { labels: ["pulled"] } },
        { name: "d", version: "4", depsDev: { labels: ["pulled", "vulnerable"] } },
      ]),
      [
        "⚠ 2 packages are flagged as malicious: a@1, b@2. Do not install them — remove them from your dependencies.",
        "⚠ 2 locked versions were pulled from the registry (often after a compromise): c@3, d@4. Upgrade or remove them.",
      ],
    );
  });

  it("lists a malicious and pulled package only as malicious", () => {
    const lines = depsDevBannerLines([
      { name: "lodahs", version: "1.0.0", depsDev: { labels: ["malicious", "pulled"] } },
      { name: "ua-parser-js", version: "0.7.29", depsDev: { labels: ["pulled"] } },
    ]);
    assert.deepEqual(lines, [
      "⚠ 1 package is flagged as malicious: lodahs@1.0.0. Do not install it — remove it from your dependencies.",
      "⚠ 1 locked version was pulled from the registry (often after a compromise): ua-parser-js@0.7.29. Upgrade or remove it.",
    ]);
  });

  it("returns only the malicious line when the sole package is malicious and pulled", () => {
    const lines = depsDevBannerLines([
      { name: "lodahs", version: "1.0.0", depsDev: { labels: ["malicious", "pulled"] } },
    ]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("malicious"));
  });
});

describe("depsDevPackageUrl", () => {
  it("builds an npm URL", () => {
    assert.equal(depsDevPackageUrl("npm", "react", "19.2.0"), "https://deps.dev/npm/react/19.2.0");
  });

  it("percent-encodes a scoped npm name", () => {
    assert.equal(
      depsDevPackageUrl("npm", "@babel/core", "7.0.0"),
      "https://deps.dev/npm/%40babel%2Fcore/7.0.0",
    );
  });

  it("percent-encodes a Go module path and keeps the version", () => {
    assert.equal(
      depsDevPackageUrl("go", "github.com/gin-gonic/gin", "v1.9.1"),
      "https://deps.dev/go/github.com%2Fgin-gonic%2Fgin/v1.9.1",
    );
  });

  it("percent-encodes a Go +incompatible version", () => {
    assert.equal(
      depsDevPackageUrl("go", "github.com/dgrijalva/jwt-go", "v3.2.0+incompatible"),
      "https://deps.dev/go/github.com%2Fdgrijalva%2Fjwt-go/v3.2.0%2Bincompatible",
    );
  });

  it("maps python to the pypi slug", () => {
    assert.equal(
      depsDevPackageUrl("python", "django", "3.2.0"),
      "https://deps.dev/pypi/django/3.2.0",
    );
  });

  it("maps rust to the cargo slug", () => {
    assert.equal(depsDevPackageUrl("rust", "serde", "1.0.0"), "https://deps.dev/cargo/serde/1.0.0");
  });

  it("returns the package URL without a version segment when version is empty", () => {
    assert.equal(depsDevPackageUrl("npm", "react", ""), "https://deps.dev/npm/react");
  });

  it("returns null for an unsupported ecosystem", () => {
    assert.equal(depsDevPackageUrl("maven", "a", "1"), null);
    assert.equal(depsDevPackageUrl("golang", "a", "1"), null);
  });

  it("returns null for an empty name", () => {
    assert.equal(depsDevPackageUrl("npm", "", "1"), null);
  });

  it("encodes characters that could break out of the path", () => {
    assert.equal(
      depsDevPackageUrl("npm", "../x?y#z", "1"),
      "https://deps.dev/npm/..%2Fx%3Fy%23z/1",
    );
  });
});
