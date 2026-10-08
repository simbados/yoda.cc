# Plan: deps.dev GOSSIP findings as a supply-chain signal (alongside socket.dev)

Status: **IMPLEMENTED 2026-10-08** (uncommitted). Definition-of-Done agents run in parallel at the user's request.
Correction found during implementation: neither the CLI nor the web UI sorted by socket score (CLI sorts by release
date; web by the clicked column), so decision 3 became "deps.dev column is sortable by severity". Follow-up 2026-10-08 (user confirmed): when deps.dev
is enabled, all outputs default to severity descending (CLI: release date as tiebreaker; web/report: name).
Also fixed: web re-sort stacked duplicate `<details>` sections for multi-ecosystem results.
Sources: <https://blog.deps.dev/gossip/>, <https://docs.deps.dev/api/v3alpha/>,
`examples/skills/scan-dependencies/SKILL.md` in github.com/google/deps.dev, and live probes of `api.deps.dev`
(2026-10-07 and 2026-10-08, ~40 packages across npm / PyPI / Go / Cargo).

## Goal

Add deps.dev's GOSSIP findings as a second, **keyless, opt-in** supply-chain signal in depsview (CLI + web),
fetched with **one batched request** for all ecosystems. socket.dev keeps working but becomes **strictly opt-in
in the web UI** (only a checkbox visible until the user enables it).

## Decisions

| #   | Question                         | Decision                                                                                                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Default on or opt-in?            | **Opt-in.** CLI flag `--deps-dev`; web checkbox whose state is **remembered** (localStorage, try/catch, per-viewer).                                             |
| 2   | How to display / score?          | **One short coloured label per package** (hover shows details) + **red banner above the table only for malicious / pulled**. No numeric score.                   |
| 3   | Sort by deps.dev when no socket? | **Yes.** Fallback sort by deps.dev severity only when socket scores are absent; socket order wins when both present.                                             |
| 4   | Doc location                     | `depsview/docs/` (this file).                                                                                                                                    |
| 5   | Shared key helper                | **Move** `scoreKey` to `src/util/` and update socket imports; socket must keep working unchanged.                                                                |
| 5b  | Socket UI                        | **Strict opt-in:** show only a "Use Socket.dev supply-chain scores" checkbox; key, org, proxy consent, remember and storage note appear only when it is checked. |

## API facts (verified)

| Item         | Value                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint     | `POST https://api.deps.dev/v3alpha/findingsbatch` (`GetFindingsBatch`). **v3alpha** — may change.                                                                  |
| Auth         | None.                                                                                                                                                              |
| Batch limit  | 5000 items per call (400 above). Paginated: re-send same body with `pageToken` = `nextPageToken` (`""` = done).                                                    |
| Systems      | `NPM`, `PYPI`, `GO`, `CARGO` — covers all four depsview ecosystems.                                                                                                |
| Request item | `{versionKey:{system,name,version}}` (exact version only) or `{packageKey:{system,name}}`.                                                                         |
| Caching      | `cache-control: public, max-age=3600`.                                                                                                                             |
| CORS         | POST answers `access-control-allow-origin: *`; `OPTIONS` preflight returns **400**. A `Content-Type: text/plain` body avoids the preflight and was accepted (200). |

Response per item: `request` (echo), `findings.requestedVersion {versionKey, findings[], cooldownEnd}`,
`findings.packageFindings[]`, `findings.defaultVersion`, `findings.recommendedVersions[]`.
Finding = `{type, risk, deprecatedContext{reason}?, cooldownContext{end}?, lowUsageContext{alternativePackages[]}?}`.

## Signal analysis — what the API actually returns and what we can conclude

| Type          | Risk seen     | Where it appears                                          | Live examples                                                                                           | What we can conclude                                                                                                                                                                                 |
| ------------- | ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MALICIOUS`   | CRITICAL      | `packageFindings`                                         | `npm lodahs`                                                                                            | Known malware (OSSF malicious-packages). **Strongest signal — never install.**                                                                                                                       |
| `NOT_FOUND`   | CRITICAL      | **version** level                                         | `ua-parser-js@0.7.29`, `colors@1.4.44-liberty-2`, `event-stream@3.3.6`, `node-ipc@10.1.1`               | The pinned version was **pulled from the registry**. Every example is a famous compromise/sabotage. Very strong signal for lock files.                                                               |
| `NOT_FOUND`   | CRITICAL      | **package** level                                         | `reqeusts`, `python-dateutils`, `is-odd-even-checker`                                                   | Package unknown to deps.dev: typo / hallucinated name, or brand-new / private. Weaker — depsview already resolved it from the public registry, so usually lag or a mirror name.                      |
| `VULNERABLE`  | CRITICAL only | version, sometimes package                                | `minimist@0.0.8`, `pyyaml@5.3`, `next@14.0.0`, `django@3.2.0`, `cargo failure`                          | Version has a **critical** advisory. **Not a full vuln scan:** `jsonwebtoken@8.5.1`, `openssl@0.10.40`, `jinja2@2.10`, old `golang.org/x/net` have known non-critical CVEs and returned **nothing**. |
| `DEPRECATED`  | MEDIUM        | version and/or package, with `reason` text                | `request`, `left-pad` ("use String.prototype.padStart()"), `axios@0.21.0`, `github.com/golang/protobuf` | Maintainer-declared deprecation. The `reason` is often actionable (replacement package, or "security fix in vX").                                                                                    |
| `COOLDOWN`    | HIGH          | versions released in the last days, `cooldownContext.end` | latest `next`, `boto3`, `tokio`, `django`                                                               | "Too new to trust yet." Relevant when the **requested** version is in cooldown (fresh release you just locked).                                                                                      |
| `REMEDIATION` | INFORMATIONAL | on **newer** versions (default/recommended)               | `axios`, `jinja2`, `ua-parser-js` latest                                                                | "This version fixes a vulnerability." Use it to label the upgrade hint, not as a problem.                                                                                                            |
| `LOW_USAGE`   | —             | —                                                         | **never observed** (incl. `expresss`, `serde-json`)                                                     | Rare in practice; support it, but don't design the UI around it.                                                                                                                                     |

Other usable fields:

- **`recommendedVersions[]`** → an **upgrade target** ("→ 1.20.0"). Often empty when the default version is
  itself in cooldown or vulnerable (`next`, `django`, `boto3`, `tokio`). Mark it as "fixes a vuln" when it
  carries `REMEDIATION`.
- **`cooldownEnd`** is present on every existing version, so the "too new" check can be done without a finding.
- **Archived/abandoned** (mentioned in the blog) is **not in the enum yet**: `dgrijalva/jwt-go` returned nothing.

**Overall conclusion:** deps.dev is an **install-safety triage**, not a vulnerability scanner and not a quality
score. It is very good at "this is malware / pulled / critically vulnerable / deprecated / just released" and
silent otherwise. "No findings" must be shown as **"no known issues"**, never as "safe" (vendor SKILL.md says
the same). This argues against a 0–100 number: most packages would score 100, and a number suggests a
precision the data doesn't have.

Possible later addition (out of scope here): `POST /v3alpha/versionbatch` returns `advisoryKeys[]` per version
(all advisories, not just critical) in the same batch style — would cover the VULNERABLE gap.

## Display (decision 2 — confirmed 2026-10-08)

### 1. One "deps.dev" column per table — short word, coloured

Each package row gets **one short label**, coloured by severity. The label names _what was found_, so the
column stays narrow (longest label is ~10 chars) and is readable without colour (terminal without ANSI,
colour-blind users). Colour alone was considered and rejected for that reason.

| Label (severity order) | Colour | Triggered by                             | Hover / tooltip text (web + report)                                                                           |
| ---------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `malicious`            | red    | `MALICIOUS`                              | "Flagged as malicious (OSSF Malicious Packages). Do not install."                                             |
| `pulled`               | red    | `NOT_FOUND` on the requested **version** | "This version is no longer in the registry — often removed after a compromise."                               |
| `vulnerable`           | orange | `VULNERABLE`                             | "Affected by a critical vulnerability." + "Fixed in ≥ x.y.z" when a recommended version carries `REMEDIATION` |
| `low usage`            | orange | `LOW_USAGE`                              | "Very low usage. Did you mean: <alternatives>?"                                                               |
| `deprecated`           | yellow | `DEPRECATED`                             | the maintainer's `reason` text                                                                                |
| `new`                  | yellow | `COOLDOWN` on the requested version      | "Released recently — in cooldown until <date>."                                                               |
| `unknown`              | yellow | `NOT_FOUND` on the **package**           | "Not known to deps.dev (typo, very new, or private name?)."                                                   |
| `ok`                   | green  | no findings                              | "No known issues found by deps.dev (this is not a guarantee)."                                                |
| _(blank)_              | —      | lookup failed / ecosystem not covered    | —                                                                                                             |

- **Several findings:** show the most severe label plus a count, e.g. `vulnerable +1`; the tooltip lists all of
  them, one per line.
- **Tooltip** = native `title` attribute set via DOM property (no HTML injection; reason strings are
  registry-controlled). Also shown on keyboard focus for accessibility.
- **Upgrade hint:** not in the cell (keeps it narrow); `recommendedVersions[0]` goes into the tooltip as
  "Recommended: x.y.z" when it differs from the installed version.
- **Terminal:** coloured label only (no hover). **JSON:** full facts —
  `depsDev: { label, severity, findings: [{type, risk, scope, reason?, until?, alternatives?}], recommended? }`.
- **Sorting:** fallback sort by severity when no socket scores (decision 3).

```
Package        Version    …   deps.dev
lodahs         1.0.0          malicious        (red)
ua-parser-js   0.7.29         pulled           (red)
next           14.0.0         vulnerable +1    (orange) tooltip: critical vuln · deprecated: "This version has a security vulnerability…"
request        2.88.2         deprecated       (yellow) tooltip: "request has been deprecated…"
lodash         4.17.21        ok               (green)
```

### 2. Banner above the table — red category only (`malicious`, `pulled`)

- Shown **only when at least one package is `malicious` or `pulled`**. No list of other findings above the table.
- Red banner directly above the affected ecosystem table (web, report, terminal), one line per kind, e.g.
  `⚠ 1 package is flagged as malicious: lodahs@1.0.0. Do not install it — remove it from your dependencies.`
  `⚠ 1 locked version was pulled from the registry (often after a compromise): ua-parser-js@0.7.29. Upgrade or remove it.`
- Lists only the affected names (normally 0–2, so short); everything else stays in the column.

### Colours

Four bands, reusing existing tokens — no new colours: red = `ANSI_RED` / `--red`, orange = `ANSI_ORANGE`
(`\x1b[38;5;208m`) / the `.age-orange` colour, yellow = `ANSI_YELLOW`, green = `ANSI_GREEN` / `--green`.
Severity order (used for "worst label" and sorting): malicious > pulled > vulnerable > low usage > deprecated >
new > unknown > ok.

No numeric score.

## Design (independent of the display choice)

### New / moved modules (browser-safe — no `node:*`)

```
src/util/scoreKey.js    scoreKey(ecosystem, name, version)  — MOVED from src/socket/client.js
                        socket/client.js keeps re-exporting it so existing imports and tests keep working
src/depsdev/client.js   fetchDepsDevFindings(packages, opts) -> Map<key, RawFindings>
                        buildFindingsRequests(packages): npm→NPM, pypi→PYPI, golang→GO, cargo→CARGO; chunks ≤ 5000
                        follows nextPageToken; joins by echoed request.versionKey (not array index);
                        sends Content-Type: text/plain; fail-soft: any error → empty Map (same contract as socket)
src/depsdev/signals.js  classifyFindings(raw) -> { label, severity, count, findings[], recommended }  (pure, no input mutation)
```

`packagesForSocket(sections)` already yields `{name, version, ecosystem(purl type)}` — reused as the input list.

### Integration points

| File                            | Change                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/socket/client.js`          | Import + re-export `scoreKey` from `src/util/scoreKey.js`; no behaviour change                                              |
| `src/main.js`                   | `--deps-dev` flag (+ usage text); one call next to the socket call; `depsDevFindings` in `outputOpts`                       |
| `src/output/formatter.js`       | deps.dev column + red-category banner; JSON `depsDev` field; sort fallback by severity when no socket scores                |
| `src/output/reportGenerator.js` | Same column (title tooltip) + banner in the standalone report; link to `https://deps.dev/{system}/{name}/{version}`         |
| `web/index.html`                | New "deps.dev signals" card with one checkbox + disclosure; socket card reduced to one checkbox, rest in a hidden container |
| `web/app.js`                    | Remember deps.dev checkbox; socket checkbox toggles the hidden fields; render display                                       |
| `web/_headers`                  | Add `https://api.deps.dev` to `connect-src`                                                                                 |
| `README.md`, `CLAUDE.md`        | Flag, display, "no findings ≠ safe", v3alpha risk, data source, CSP host, module map                                        |

### Socket strict opt-in (web)

- Initial state: only `[ ] Use Socket.dev supply-chain scores (needs an API key)`.
- Checked → reveal key, org, proxy consent, "remember key and org" and storage note (`hidden` attribute toggle,
  no DOM rebuild).
- The checkbox state is remembered. If a key/org is already saved, it starts checked (so existing users keep
  their setup).
- Unchecked → socket is not called even if fields contain values; saved key/org are **not** deleted unless
  "remember" is unticked (current behaviour).
- The "How it works" note about Socket and the Supply Chain column only appear when socket is used.
- CLI is already opt-in (`--socket-key`/`--socket-org` or env vars): no change.

### Browser

The `text/plain` approach is verified with curl only. Checking it in a real browser needs your permission
(`yoda/CLAUDE.md`). Fallback: a `/deps-dev` route in `worker/socket-proxy.js` with a consent checkbox.
Privacy: package names + versions go to Google's `api.deps.dev` — stated next to the checkbox and in the README.

### Security notes for `security-reviewer`

- `deprecatedContext.reason` and `lowUsageContext.alternativePackages[]` are registry-influenced → `textContent`
  only in web/report, HTML-escaped in HTML output, control/ANSI characters stripped in the terminal.
- Links: `encodeURIComponent` per path segment.
- Only whitelisted fields read; results in `Map`; unknown `type`/`risk` values treated as informational.
- No mutation of inputs.

## Implementation order (Definition of Done)

1. ~~Label wording + banner scope confirmed~~ (done 2026-10-08).
2. Move `scoreKey`; add `src/depsdev/*`; wire CLI, formatter, report, web, `_headers`; socket strict opt-in UI.
3. `oxfmt`, `npm test` (existing socket tests must still pass unchanged).
4. `test-writer` → `security-reviewer` → `architecture-reviewer`, **sequentially**.
   Fixtures from the probe responses in `test/fixtures/depsdev/`.
5. README + CLAUDE.md.
6. Ask permission for a live browser check of the CORS path and the opt-in UI.

## Risks

- `v3alpha` can change → one client module, fixture tests, fail-soft, tolerant enum handling.
- No rate limit found in the docs; one call (plus pages) per run.
- Version `NOT_FOUND` on a private/mirror version can be a false alarm → private packages are already excluded by
  `registryFilter`; the wording says "not found in registry (possibly pulled)", not "malicious".
- Coverage: Go only via proxy.golang.org; PyPI only wheels/sdists; `VULNERABLE` = critical only.
