# Project Overview

depsview lists the dependencies and transitive dependencies of a Python, npm, or Go project. It runs as a CLI and as a browser-only web UI. All metadata is fetched live from public registries — no local language toolchain is required.

External data sources: `pypi.org`, `pypistats.org` (optional Python download stats), `registry.npmjs.org`, `proxy.golang.org`, `api.github.com`, `socket.dev` (optional supply-chain scores).

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
    depResolver.js          Fetches package metadata from registry.npmjs.org
    registryFilter.js       Splits packages into public (registry.npmjs.org) vs private by resolved URL

  python/
    parserCore.js           Pure string parsers for requirements.txt, pyproject.toml, setup.cfg, Pipfile, manifest.json
    parser.js               Node.js filesystem wrapper
    depResolver.js          Fetches metadata from pypi.org; optionally download stats from pypistats.org

  go/
    parserCore.js           Pure string parsers for go.sum and go.mod
    parser.js               Node.js filesystem wrapper
    depResolver.js          Fetches metadata from proxy.golang.org

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
```

## Two code paths, one shared core

```
CLI:  main.js → orchestrator.js → src/npm/parser.js       (reads local filesystem)
                                 → src/python/parser.js
                                 → src/go/parser.js

Web:  web/app.js            → src/github/parser.js         (fetches via GitHub API)
```

Both paths use the **same** parser cores (`parserCore.js`, `lockParser.js`, etc.) and resolver modules. `src/github/parser.js` is the web equivalent of the three `src/*/parser.js` files combined.

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

Files ending in `parserCore.js` and all individual lock parser files (`lockParser.js`, `pnpmLockParser.js`, `bunLockParser.js`, `yarnLockParser.js`, `lockRegistry.js`) **must not import Node.js built-ins** (`fs`, `path`, etc.). They are loaded directly in the browser via the `web/src` symlink.

## How to add a new npm lock file format

1. Create `src/npm/myLockParser.js` — export `parseMyLock(content, includeTests)` returning the parser contract above. No Node.js imports.
2. Add one entry to `NPM_LOCK_FILES` in `src/npm/lockRegistry.js` with `filename`, `parse`, `getNote`, `getWarning`, and `getDangerousDeps`. That is the only file that needs to change — both CLI and web pick it up automatically.
3. Follow the project Definition of Done in `yoda/CLAUDE.md` (test-writer → security-reviewer → architecture-reviewer → README).

## How to add a new ecosystem

1. Create `src/{eco}/parserCore.js` (pure string parser), `src/{eco}/parser.js` (fs wrapper), `src/{eco}/depResolver.js`.
2. Add web support in `src/github/parser.js` (new `parseGithub{Eco}Dependencies` function).
3. Register in `src/orchestrator.js` (import + add to pipeline).
4. Register in `web/app.js` (detectEcosystems, ECOSYSTEM_ORDER, section rendering).
5. Register in `src/main.js` (ecosystem flag + `{ECO}_FILES` set).

## Test layout

```
test/
  npm/      mirrors src/npm/   — one .test.js per source file
  python/   mirrors src/python/
  go/       mirrors src/go/
  fixtures/ minimal real-world lock files used by parser tests
```

Framework: Node.js built-in `node:test` + `node:assert/strict`. Run with `npm test`.
