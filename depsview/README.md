# depsview

Lists all dependencies and transitive dependencies of a Python, npm, or Go project. For each package it shows the resolved version, release dates, and total number of published versions. All data is fetched live — no local Python, Node.js, or Go installation required.

Built with [Claude Code](https://claude.ai/code).

**Data sources:** [PyPI](https://pypi.org/) for Python packages, [registry.npmjs.org](https://registry.npmjs.org) for npm packages, [proxy.golang.org](https://proxy.golang.org/) for Go modules, [api.github.com](https://docs.github.com/en/rest) for GitHub URL support, [pypistats.org](https://pypistats.org/) for Python download statistics (optional), [socket.dev](https://socket.dev/) for supply chain security scores (optional).

## Requirements

Node.js 18 or later. No third-party dependencies.

## Usage

```bash
node src/main.js <path-to-project|github-url> [options]
node src/main.js --package|-p <name> --npm|--python|--go
```

Every ecosystem detected at the project root is resolved and rendered as its own section, in the fixed order **npm → python → go**. Pass any combination of `--npm`, `--python`, `--go` to *filter* — with no flags all detected ecosystems are included.

```bash
# Auto-detect every ecosystem present
node src/main.js ./my-python-project
node src/main.js ./mixed-repo                      # polyglot: each ecosystem gets its own section
node src/main.js https://github.com/owner/repo

# Restrict to specific ecosystems
node src/main.js ./mixed-repo --npm                # only the npm section
node src/main.js ./mixed-repo --python --go        # python + go sections only

# Search by package name (requires one ecosystem flag)
node src/main.js -p eslint --npm
node src/main.js -p eslint@8.57.0 --npm
node src/main.js -p requests --python
node src/main.js -p "requests>=2.0" --python
node src/main.js -p github.com/gin-gonic/gin --go
node src/main.js -p github.com/gin-gonic/gin@v1.9.1 --go
```

**Example output (npm):**

```
Resolving npm dependencies from package-lock.json (142 installed)...

Package     Version   Released     First Release  Releases  Link
------------------------------------------------------------------
vite        5.1.0     2024-02-08   2020-04-25     89        https://www.npmjs.com/package/vite
lodash      4.17.21   2021-02-20   2012-01-13     116       https://www.npmjs.com/package/lodash
eslint      8.57.0    2024-02-24   2013-06-23     312       https://www.npmjs.com/package/eslint
------------------------------------------------------------------
142 packages total
```

**Example output (Python):**

```
Resolving python dependencies from requirements.txt (2 direct)...

Package   Version   Released     First Release  Releases  Link
---------------------------------------------------------------
requests  2.31.0    2023-05-22   2011-02-14     144       https://pypi.org/project/requests/
certifi   2024.2.2  2024-02-02   2011-09-30     29        https://pypi.org/project/certifi/
---------------------------------------------------------------
2 packages total  (2 direct, 0 transitive)
```

**Example output (polyglot — `package.json` + `go.mod`):**

```
Resolving ecosystems: npm, go…

=== npm ===
Package  Version  Released     First Release  Releases  Link
-------------------------------------------------------------
vite     5.1.0    2024-02-08   2020-04-25     89        https://www.npmjs.com/package/vite
…
142 packages total

=== go ===
Package                      Version  Released     Releases  Link
------------------------------------------------------------------
github.com/gin-gonic/gin     v1.9.1   2023-06-01   28        https://pkg.go.dev/github.com/gin-gonic/gin@v1.9.1
…
3 packages total  (2 direct, 1 transitive)
```

Each section is sorted independently by release date (newest first). In the web UI and HTML report, click any column header to re-sort — each table has its own sort state.

## Web UI — package search

When a specific ecosystem is selected (npm, Python, or Go), the URL field is replaced with a multi-line textarea. Enter one or more package identifiers and click **Analyse**.

**Supported separator formats** — all of these are equivalent:

| Style | Example |
|---|---|
| One per line | `eslint` ↵ `eslint@9` |
| Comma-separated | `eslint, eslint@9` or `eslint,eslint@9` |
| Any character flanked by spaces | `eslint \| eslint@9` · `eslint ; eslint@9` |

Characters that are part of package identifiers (`@`, `.`, `-`, `/`, `=`, `>`, `<`, `~`, `!`, `+`) are never treated as separators, so Go module paths (`github.com/gin-gonic/gin`) and Python specifiers (`requests>=2.0`) are always kept intact.

Selecting **All** restores the GitHub URL input for full-repository analysis.

## Multi-ecosystem projects

Polyglot repos (e.g. a project with both `package.json` and `go.mod`, or a Python monorepo that also bundles a JS frontend) are resolved **per ecosystem**. Every detected ecosystem produces its own section with its own table, summary, and sort state. Sections always appear in the order **npm → python → go**.

Behaviour per surface:

- **CLI text:** each section is separated by a `=== <ecosystem> ===` header (header omitted when only one ecosystem is present).
- **JSON:** top-level object keyed by ecosystem — see the [JSON output](#json-output) section below.
- **HTML report:** one `<section>` per ecosystem with an independently-sortable table.
- **Web UI:** one block per ecosystem, each block sortable on its own.

Errors are isolated per section — if `go.mod` is malformed but `package.json` is fine, only the Go section reports the error and npm still resolves.

When `--socket-key` / `--socket-org` are supplied, a **single** batched request to socket.dev covers packages from every ecosystem (mixing `pkg:npm/…`, `pkg:pypi/…`, and `pkg:golang/…` PURLs in one call).

## Flags

| Flag | Description |
|---|---|
| `--npm` | Restrict the run to npm sections |
| `--python` | Restrict the run to Python sections |
| `--go` | Restrict the run to Go sections |
| `--package <name>` / `-p <name>` | Resolve a single package by name instead of reading dep files. Requires exactly one ecosystem flag. Accepts `name`, `name@version`, PEP 440 specifiers for Python, and `module@version` for Go. Transitive dependencies are followed for all three ecosystems. |
| `--include-tests` | Include dev/test dependencies (npm / Python only) |
| `--json` | Machine-readable JSON output |
| `--download-stats` / `--ds` | Fetch Python download counts from pypistats.org (Python only) |
| `--socket-key=<key>` | Socket.dev API key — enables the Supply Chain column |
| `--socket-org=<slug>` | Socket.dev organisation slug (required with `--socket-key`) |
| `--report[=<file>]` | Write a self-contained HTML report (default: `depsview-report.html`) |
| `--debug` | Print API errors and warnings to stderr |

Both socket flags can also be supplied as environment variables `SOCKET_KEY` and `SOCKET_ORG`; the `--socket-key` / `--socket-org` flags take precedence when both are present.

## npm support

Lock files are always preferred over `package.json`. The priority order is:

1. `package-lock.json` (npm)
2. `pnpm-lock.yaml` (pnpm)
3. `package.json` (fallback — recursive registry resolution)

### package-lock.json

When a `package-lock.json` is present, depsview reads the complete list of installed packages directly from it — no recursive registry traversal needed. Packages flagged `"dev": true` are excluded unless `--include-tests` is passed.

Supports lockfileVersion 1, 2, and 3.

### pnpm-lock.yaml

When a `pnpm-lock.yaml` is present, depsview reads the flat package list from the `packages:` section.

Supports lockfile versions 5, 6, and 9:

| Version | pnpm | Dev-package detection |
|---|---|---|
| 5 | ≤6 | `dev: true` flag inside each entry |
| 6 | 7/8 | `dev: true` flag inside each entry |
| 9 | 9+ | `devDependencies` in the `importers:` section |

### package.json fallback

When no lock file is found, depsview reads `package.json` and recursively resolves all transitive dependencies from the npm registry, following each package's `dependencies` field.

### Scoped packages

Scoped package names (e.g. `@babel/core`, `@types/node`) are fully supported throughout.

### devDependencies

Pass `--include-tests` to include `devDependencies` alongside `dependencies`.

### Private registries

Packages from private or custom registries are **automatically skipped**. When a `package-lock.json` or `pnpm-lock.yaml` contains a package whose `resolved` URL does not start with `https://registry.npmjs.org/`, that package is excluded and not looked up. The count of skipped packages is printed to stderr (CLI) or shown in the results when any are found (web).

## Python support

### Supported dependency file formats

| File | Format | Notes |
|---|---|---|
| `pyproject.toml` | PEP 621 `[project] dependencies` or Poetry `[tool.poetry.dependencies]` | Optional deps excluded |
| `manifest.json` | Home Assistant integration manifest | Reads `requirements` array |
| `requirements.txt` | pip requirements format | Supports `-r` file includes |
| `requirements_all.txt` | pip requirements format | Same as `requirements.txt`; both are parsed when present |
| `setup.cfg` | `[options] install_requires` | |
| `Pipfile` | Pipenv | Reads `[packages]` only |

All matching files are parsed and merged. When the same package appears in multiple files its version constraints are combined.

When a project contains **both** `requirements.txt` and `requirements_all.txt`, both files are parsed and their dependency lists merged. If `requirements_all.txt` already pulls `requirements.txt` in via a `-r` include, the latter is not parsed a second time — each package appears once.

### Version constraints

All standard [PEP 440](https://peps.python.org/pep-0440/) specifiers are supported: `==`, `>=`, `<=`, `>`, `<`, `!=`, `~=`, and bare package names (resolves to latest stable).

### Download statistics

Pass `--download-stats` (or `--ds`) to also fetch monthly download counts from [pypistats.org](https://pypistats.org/). Disabled by default to avoid rate-limit errors on large projects.

### URL-pinned packages

[PEP 508](https://peps.python.org/pep-0508/) URL requirements (`package @ https://...`) are **silently skipped** — they are pinned to a specific URL rather than a registry and cannot be resolved via PyPI. This includes wheel URLs, VCS references (`@ git+https://...`), and local file paths (`@ file://...`). Plain package names and version constraints are unaffected.

## Go support

Lock files are preferred over module files. The priority order is:

1. `go.sum` (Go modules) — full transitive closure with pinned versions
2. `go.mod` (fallback) — direct + `// indirect` requirements only

### go.sum

When `go.sum` is present, depsview reads every module zip-hash entry (the lines without the `/go.mod` suffix) and resolves metadata for each pinned version. `/go.mod`-suffixed lines are ignored because they correspond to modules referenced only by lazy-loading traversal and may not actually be in the build graph.

When both `go.sum` and `go.mod` are present, the matching `go.mod` is read alongside to determine which modules are direct (non-`// indirect`) for the footer count.

### go.mod fallback

When only `go.mod` is present, every `require` entry is resolved. Entries marked `// indirect` are flagged as transitive in the footer; entries without the marker are reported as direct.

`module`, `go`, `toolchain`, `replace`, `exclude`, and `retract` directives are ignored.

### Metadata

For each module, depsview queries the [Go module proxy](https://proxy.golang.org/):

- `/{module}/@v/{version}.info` for the release date of the pinned version
- `/{module}/@v/list` for the total number of tagged releases
- `/{module}/@v/{version}.mod` for transitive dependency discovery (package-search mode only)

Module paths with uppercase letters are encoded per the GOPROXY protocol (e.g. `github.com/BurntSushi/toml` → `github.com/!burnt!sushi/toml`). The "First Release" column is reported as **unknown** for Go modules to avoid one extra request per package; the "Downloads/mo" column does not apply because the proxy does not expose install counts. The `--include-tests` flag has no effect on Go projects — `go.sum` and `go.mod` do not distinguish test-only dependencies.

The supply chain score (with `--socket-key` / `--socket-org`) works for Go modules and is fetched using the `pkg:golang/...` PURL type.

### Private modules

Modules whose path hostname is not a known public host are **automatically skipped** — they cannot be resolved via `proxy.golang.org`. Public hosts include `github.com`, `golang.org`, `google.golang.org`, `go.uber.org`, and many others. Internal or corporate module paths (e.g. `corp.internal/pkg`) are excluded and the count of skipped modules is printed to stderr (CLI) or shown in the results header (web).

## GitHub URL support

Pass a GitHub repository URL instead of a local path:

```bash
node src/main.js https://github.com/owner/repo
node src/main.js https://github.com/owner/repo/tree/main
node src/main.js https://github.com/owner/repo/tree/main/subfolder
```

Ecosystem is auto-detected from the root directory listing. Python projects are traversed up to two levels deep; npm and Go projects are read from the specified directory only.

**Authentication:** the GitHub API allows 60 unauthenticated requests/hour. Set `GITHUB_TOKEN` for private repos or to raise the limit to 5 000/hour:

```bash
GITHUB_TOKEN=ghp_... node src/main.js https://github.com/owner/private-repo
```

## Output columns

| Column | Description |
|---|---|
| Package | Package name (links to registry page in web UI) |
| Version | Resolved version |
| Released | Date the resolved version was published |
| First Release | Date the package first appeared on its registry |
| Releases | Total number of published versions |
| Downloads/mo | Python only, with `--download-stats` |
| Supply Chain | Score 0–100 % from socket.dev (requires `--socket-key` + `--socket-org`) |
| Link | Registry page URL (CLI only) |

### Color coding (CLI)

Date cells use the same scheme in both the `Released` and `First Release` columns:

| Color | Cell | Meaning |
|---|---|---|
| Red    | Released / First Release | 3 days ago or less    |
| Orange | Released / First Release | 7 days ago or less    |
| Yellow | Released / First Release | 30 days ago or less   |
| Green  | Supply Chain | Score ≥ 80 % |
| Yellow | Supply Chain | Score 50–79 % |
| Red    | Supply Chain | Score < 50 % |

No color codes are emitted when output is piped or redirected.

### JSON output

```bash
node src/main.js <path-or-url> --json
```

Output is a top-level object keyed by ecosystem (always in the fixed order `npm` → `python` → `go`). Ecosystems with no detected files are omitted.

```json
{
  "npm": [
    {
      "name": "lodash",
      "version": "4.17.21",
      "released": "2021-02-20",
      "firstReleased": "2012-01-13",
      "releases": 116,
      "link": "https://www.npmjs.com/package/lodash"
    }
  ],
  "go": [
    {
      "name": "github.com/gin-gonic/gin",
      "version": "v1.9.1",
      "released": "2023-06-01",
      "releases": 28,
      "link": "https://pkg.go.dev/github.com/gin-gonic/gin@v1.9.1"
    }
  ]
}
```

Per-ecosystem field rules:
- `firstReleased` is **omitted for Go entries** (the Go module proxy does not expose a cheap first-release timestamp).
- `downloadsLastMonth` is included **only for Python entries when `--download-stats` is passed**.
- `supplyChainScore` is included on every entry when socket.dev credentials are provided.

When `--socket-key` and `--socket-org` are provided, each entry additionally contains:

```json
{
  "supplyChainScore": 0.87
}
```

`supplyChainScore` is `null` when the package was not returned by the socket.dev API.

### HTML report

```bash
node src/main.js <path-or-url> --report                 # writes depsview-report.html
node src/main.js <path-or-url> --report=custom-name.html
```

Generates a self-contained HTML file (all CSS inlined, no external dependencies) that replicates the terminal table with the same dark theme used by the web UI. The report can be opened directly in a browser, attached to a PR, or shared via email. All flags that affect the terminal table (`--download-stats`, `--socket-key`, etc.) are reflected in the report. The `--report` flag can be combined with `--json` — the JSON goes to stdout and the HTML is written to the file.

Every column header is clickable: click once to sort ascending, click again to toggle descending. The default sort is release date descending (newest first). String columns (Package, Version) default to ascending on first click; all other columns (dates, counts, Supply Chain score) default to descending.

## Excluding test dependencies

By default the following are excluded (Python):

- **Test directories** — `test`, `tests`, `testing`, `e2e`, `integration_tests` are not traversed on GitHub.
- **Test requirement files** — `-r` includes matching `test`, `dev`, `lint`, `docs`, `ci` are skipped.
- **Poetry dev-deps** — `[tool.poetry.dev-dependencies]` and group sections.
- **Pipenv dev-packages** — `[dev-packages]` in `Pipfile`.

For npm: `devDependencies` in `package.json` and packages flagged `"dev": true` in the lock file are excluded.

For Go: `go.sum` and `go.mod` do not distinguish test-only dependencies, so no filtering applies and `--include-tests` is a no-op.

Pass `--include-tests` to disable all filtering.

## Web interface

Open the browser UI with the Go server from the repo root:

```bash
npm run prepare   # creates web/src → src symlink (first time only)
go run server.go
# open http://localhost:8080/web/
go run server.go -port 9000   # custom port
go run server.go -dir ./web   # serve a different directory
```

The web UI supports the same GitHub URL formats as the CLI. It links each package to its registry page (PyPI or npmjs.com).

**Python download statistics** — pypistats.org does not emit CORS headers, so the browser cannot call it directly. Tick **Show Python download statistics** before analysing; requests are routed through the same Cloudflare Worker proxy (`socket-proxy.yoda.cc`) used for socket.dev, which adds CORS headers and forwards the response unchanged. The Downloads/mo column appears in the Python section only when this option is enabled.

### Ecosystem filter

Use the **Ecosystem** segmented control to restrict analysis to a single ecosystem:

- **All** (default) — auto-detects every ecosystem present in the repository, producing one section per ecosystem.
- **npm / Python / Go** — skips detection and resolves only the chosen ecosystem, even when files from other ecosystems are present.

### Package name search

When a specific ecosystem is selected, you can type a package name directly instead of a GitHub URL:

| Ecosystem | Example input |
|---|---|
| npm | `eslint` · `eslint@8` · `@babel/core@7` |
| Python | `requests` · `requests>=2.0` · `requests==2.31.0` |
| Go | `github.com/gin-gonic/gin` · `github.com/gin-gonic/gin@v1.9.1` · `golang.org/x/lint/golint@latest` |

For Go, tool package paths (e.g. `golang.org/x/lint/golint`) are automatically resolved to their containing module root (`golang.org/x/lint`), mirroring what `go install` does.

For **All**, only GitHub URLs are accepted.

### GitHub token in the web UI

Enter a personal access token in the **GitHub token** field. It is used only for `api.github.com` and never sent elsewhere. Check **Remember token** to persist it in `localStorage`.

### Socket.dev Supply Chain scores in the web UI

The socket.dev API does not emit CORS headers, so browser requests must go through a Cloudflare Worker proxy. A minimal proxy lives in the `worker/` directory.

**Deploy the proxy (once):**

```bash
cd worker
pnpm install          # installs wrangler
pnpx wrangler login    # first-time only
pnpx wrangler deploy   # prints your Worker URL, e.g. https://socket-proxy.yourname.workers.dev
```

**Wire up the URL:**

Set `SOCKET_PROXY_BASE` in `web/app.js` to your deployed Worker URL (no trailing slash):

```js
const SOCKET_PROXY_BASE = 'https://socket-proxy.yourname.workers.dev';
```

After that, all visitors can use the supply chain feature — they only need their own API key and org slug.

**Using the feature:**

Enter your Socket.dev API key and organisation slug in the corresponding fields. When both are provided and `SOCKET_PROXY_BASE` is set, a Supply Chain column is added to the results table. Check **Remember Socket key and org slug** to persist them in `localStorage`.

Requests flow: **browser → Cloudflare Worker → api.socket.dev**. The API key is forwarded by the Worker and is never stored in it.

## Debug mode

```bash
node src/main.js <path-or-url> --debug
```

Debug lines are prefixed with `[debug]` and always go to stderr so they don't interfere with `--json` or piped output.

## Running tests

```bash
npm test
```
