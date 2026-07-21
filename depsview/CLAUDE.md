# Project Overview

depsview lists the dependencies and transitive dependencies of a Python, npm, Go, or Rust project. It runs as a CLI and as a browser-only web UI. All metadata is fetched live from public registries — no local language toolchain is required.

External data sources: `pypi.org`, `pypistats.org` (optional Python download stats), `registry.npmjs.org`, `api.npmjs.org` (npm download counts), `proxy.golang.org`, `crates.io`, `api.github.com`, `socket.dev` (optional supply-chain scores).

Cross-cutting rules (no third-party deps, plan-first, mandatory docstrings, coding style, the three project agents, Definition of Done) live in `yoda/CLAUDE.md` and apply here.

# Architecture

## Module map

```
src/
  main.js                   CLI entry point — arg parsing, ecosystem detection, output dispatch
  orchestrator.js           Runs parse → resolve pipeline per ecosystem; returns one section per ecosystem

  npm/
    lockRegistry.js         ★ SINGLE SOURCE OF TRUTH for lock file support. Add new lock formats here only.
                              Exports NPM_LOCK_FILES (ordered descriptors) and NPM_LOCK_FILENAMES (Set).
    lockParser.js           package-lock.json parser (v1/v2/v3) — pure string, browser-safe
    pnpmLockParser.js       pnpm-lock.yaml parser (v5/v6/v9) — pure string, browser-safe
    bunLockParser.js        bun.lock parser (Bun 1.2+ text format) — pure string, browser-safe
    yarnLockParser.js       yarn.lock parser (Classic v1 + Berry v2+) — pure string, browser-safe
    parserCore.js           package.json parser — pure string, browser-safe
    parser.js               Node.js filesystem wrapper; iterates lockRegistry then falls back to package.json
    depResolver.js          Fetches package metadata from registry.npmjs.org; post-pass attaches download counts
    npmStatsClient.js       api.npmjs.org download-counts client (last-month, bulk + scoped) — browser-safe
    registryFilter.js       Splits packages into public (registry.npmjs.org) vs private by resolved URL

  python/
    parserCore.js           Pure string parsers for requirements.txt, pyproject.toml, setup.cfg, Pipfile, manifest.json
    parser.js               Node.js filesystem wrapper
    depResolver.js          Fetches metadata from pypi.org; optionally download stats from pypistats.org

  go/
    parserCore.js           Pure string parsers for go.sum and go.mod
    parser.js               Node.js filesystem wrapper
    depResolver.js          Fetches metadata from proxy.golang.org

  rust/
    parserCore.js           Pure string parsers for Cargo.toml and Cargo.lock (minimal TOML) — browser-safe
    versionResolver.js      Cargo SemVer resolver (caret-by-default, comma-AND) — browser-safe
    crateFilter.js          Splits packages into public (crates.io index) vs private by source — browser-safe
    parser.js               Node.js filesystem wrapper; prefers Cargo.lock, falls back to Cargo.toml
    cratesClient.js         crates.io JSON API client (crate info, version metadata, transitive deps)
    depResolver.js          Resolves via crates.io in lockfile or manifest mode

  github/
    client.js               GitHub Contents API client (listDirectory, fetchFileContent)
    parser.js               Web/GitHub equivalents of all ecosystem parsers — fetches files via API
                              Uses lockRegistry.js for npm lock file detection (same as CLI)
    url.js                  Parses GitHub URLs into { owner, repo, ref, subpath }

  output/
    formatter.js            Terminal (ANSI), JSON, and HTML table output
    reportGenerator.js      Standalone HTML report
    nonStandardSources.js   Groups private/dangerous deps by domain for the warning block

  socket/
    client.js               Fetches supply-chain scores from socket.dev

web/
  app.js                    Browser entry point — GitHub mode UI, calls src/github/parser.js
  src → symlink to ../src   Shared source used by both CLI and web
  _headers                  Cloudflare Pages headers — CSP (incl. connect-src allowlist), HSTS, etc.
```

## Two code paths, one shared core

```
CLI:  main.js → orchestrator.js → src/npm/parser.js       (reads local filesystem)
                                 → src/python/parser.js
                                 → src/go/parser.js
                                 → src/rust/parser.js

Web:  web/app.js            → src/github/parser.js         (fetches via GitHub API)
```

Both paths use the **same** parser cores (`parserCore.js`, `lockParser.js`, etc.) and resolver modules. `src/github/parser.js` is the web equivalent of the four `src/*/parser.js` files combined.

## Content-Security-Policy allowlist (web only)

The web app is served by Cloudflare Pages with a strict CSP defined in `web/_headers`. `default-src 'none'` blocks everything by default, so **every host the browser fetches directly must be listed in `connect-src`**. It is not enough for the upstream host to send CORS headers — a missing `connect-src` entry makes the browser refuse the request before it is sent (`Refused to connect … violates the document's Content Security Policy`). Current `connect-src` hosts: `api.github.com`, `pypi.org`, `registry.npmjs.org`, `api.npmjs.org` (npm download counts), `proxy.golang.org`, `crates.io`, `socket-proxy.yoda.cc` (the Worker proxy for pypistats + socket.dev). Whenever a resolver or client starts fetching a new host from browser-loaded code, add it here or the feature works on the CLI but silently fails in the web UI. The standalone HTML report (`src/output/reportGenerator.js`) has its own inline CSP but makes no network requests (all data is baked in), so it needs no `connect-src`.

## Parser contract

Every lock file parser returns:
```js
Array<{ name: string, version: string, resolved: string|null }>
```
`resolved` must be `null` or a `https://` URL — non-https values are discarded at parse time.

`parseDependencyFile()` (both CLI and web) returns:
```js
{ deps, source, note, warning, privateCount, privatePkgs, dangerousDeps }
```
where `deps` contains only public-registry packages (private ones are in `privatePkgs`).

## Browser-compatibility rule

Files ending in `parserCore.js`, all individual lock parser files (`lockParser.js`, `pnpmLockParser.js`, `bunLockParser.js`, `yarnLockParser.js`, `lockRegistry.js`), the npm registry/download clients (`npm/npmClient.js`, `npm/npmStatsClient.js`), and the Rust browser-loaded helpers (`rust/versionResolver.js`, `rust/crateFilter.js`) **must not import Node.js built-ins** (`fs`, `path`, etc.). They are loaded directly in the browser via the `web/src` symlink. The `parser.js` files (including `rust/parser.js`) are the Node-only fs wrappers and are never loaded in the browser.

## How to add a new npm lock file format

1. Create `src/npm/myLockParser.js` — export `parseMyLock(content, includeTests)` returning the parser contract above. No Node.js imports.
2. Add one entry to `NPM_LOCK_FILES` in `src/npm/lockRegistry.js` with `filename`, `parse`, `getNote`, `getWarning`, and `getDangerousDeps`. That is the only file that needs to change — both CLI and web pick it up automatically.
3. Follow the project Definition of Done in `yoda/CLAUDE.md` (test-writer → security-reviewer → architecture-reviewer → README).

## How to add a new ecosystem

1. Create `src/{eco}/parserCore.js` (pure string parser), `src/{eco}/parser.js` (fs wrapper), `src/{eco}/depResolver.js`. Add any registry-client or resolver helpers the ecosystem needs (e.g. Rust adds `cratesClient.js`, `versionResolver.js`, `crateFilter.js`); browser-loaded helpers must not import `node:*` and go in the browser-compatibility list.
2. Add web support in `src/github/parser.js` (new `parseGithub{Eco}Dependencies` function + export).
3. Register in `src/orchestrator.js` (import + wire into parseSection / resolveSectionDeps / directNamesForSection / packagesForSocket, including the PURL type).
4. Register in `web/app.js` (detectEcosystems, ECOSYSTEM_ORDER, ECOSYSTEM_PURL_TYPE, SOCKET_URL_SLUG, section rendering) and add the radio in `web/index.html`.
5. Register in `src/main.js` (ecosystem flag + `{ECO}_FILES` set + detection).
6. Register in `src/output/formatter.js` (ECOSYSTEM_ORDER + PURL mapping) and `src/packageInput.js` (`parse{Eco}` for `--package` input).
7. If the ecosystem's browser-loaded code fetches any new host (registry, stats API, etc.), add that host to the `connect-src` allowlist in `web/_headers` — otherwise the web UI is blocked by CSP even though the CLI works.

## Test layout

```
test/
  npm/      mirrors src/npm/   — one .test.js per source file
  python/   mirrors src/python/
  go/       mirrors src/go/
  rust/     mirrors src/rust/
  fixtures/ minimal real-world lock files used by parser tests
            (cargo-lock, cargo-toml, cargo-private for Rust)
```

Framework: Node.js built-in `node:test` + `node:assert/strict`. Run with `npm test`.
