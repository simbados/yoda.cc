# Project Overview
Show dependencies and transitive dependencies in a project. It prints a list of all dependencies. It uses
https://pypi.org/ for package metadata and https://pypistats.org/ for download statistics and github if you use the github link feature. No other resources are used.

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
{ deps, source, note, privateCount, privatePkgs, dangerousDeps }
```
where `deps` contains only public-registry packages (private ones are in `privatePkgs`).

## Browser-compatibility rule

Files ending in `parserCore.js` and all individual lock parser files (`lockParser.js`, `pnpmLockParser.js`, `bunLockParser.js`, `lockRegistry.js`) **must not import Node.js built-ins** (`fs`, `path`, etc.). They are loaded directly in the browser via the `web/src` symlink.

## How to add a new npm lock file format

1. Create `src/npm/myLockParser.js` — export `parseMyLock(content, includeTests)` returning the parser contract above. No Node.js imports.
2. Add one entry to `NPM_LOCK_FILES` in `src/npm/lockRegistry.js` with `filename`, `parse`, and `getNote`. That is the only file that needs to change — both CLI and web pick it up automatically.
3. Run `test-writer` then `security-reviewer`.

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

# Documentation
- **README must stay current:** After every implementation update the README to reflect any new flags, behaviour, file formats, or limitations introduced by the change.

# Coding Rules & Behavior
- **Plan first, always:** Before implementing any feature or change, present a concise plan — what will be created or modified and why — and wait for confirmation before writing any code.
- **Mandatory Documentation:** You MUST add a detailed docstring/comment to *every single function* you create. Explain its purpose, arguments, and return values.
- **Explain Your Work:** Before executing code changes, briefly explain the logic of the functions you are about to create in the chat.
- **No Silent Updates:** Do not make sweeping changes to files without telling me what you are modifying first.
- **No dependencies added** Do not add any dependencies for this project. This is a plain javascript project

# Coding Style
- **No mutating input parameters:** Functions must not mutate objects or arrays passed in as arguments (e.g. no accumulator/out parameters). Always return new values instead.
- **Prefer async/await over Promise chains:** Use `async`/`await` syntax instead of `.then()`/`.catch()` for all asynchronous code. Reserve `.catch()` only when attaching a handler to a Promise you are not awaiting inline.

# Agents
Two project agents live in `.claude/agents/`. **Always run them sequentially — never in parallel:**

1. **`test-writer`** — invoke first. When a new source file is created or new exported functions are added without test coverage. Pass the source file path. It reads the file, matches existing test style, writes the test file, and runs `npm test`. Wait for it to complete and confirm all tests pass before continuing.
2. **`security-reviewer`** — invoke second, only after `test-writer` has completed successfully. Pass the changed file paths or let it diff against HEAD. It checks the project-specific attack surfaces (XSS via registry data, URL injection, prototype pollution, path traversal, ReDoS) and produces a structured PASS/FAIL report.

# Testing
- **Every new function must be tested:** Use the `test-writer` agent for new source files. It is responsible for writing tests and verifying they pass.

# Security
- **Security review after every implementation:** Use the `security-reviewer` agent after writing new code. Fix any findings before the task is considered done and document the fix briefly in the chat.

# Definition of Done
A task is only complete when ALL of the following have been done **in this exact order**:
1. `test-writer` agent invoked for any new or changed source files — wait for completion, all tests must pass
2. `security-reviewer` agent invoked — wait for completion, fix any findings before closing
3. README updated to reflect the change