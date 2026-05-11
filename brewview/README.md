# brewview

Resolves and displays the full transitive dependency tree of a Homebrew formula. For each package it shows the resolved version, last updated date, and annual install count. All data is fetched live in the browser — no local Homebrew installation required.

Built with [Claude Code](https://claude.ai/code).

**Data sources:** [formulae.brew.sh](https://formulae.brew.sh/) for formula metadata and install analytics, [api.github.com](https://docs.github.com/en/rest) for formula last-updated dates.

## Usage

Open the web UI, enter a formula name (e.g. `ffmpeg`, `wget`, `openssl@3`), and click **Analyse**.

Optionally check **Include build dependencies** to include packages that are only required at build time.

## How it works

1. **BFS resolution** — starting from the root formula, brewview fetches each formula's metadata from the Homebrew API and walks the dependency graph breadth-first. Runtime and recommended dependencies are always included; build dependencies are included when the checkbox is checked. System libraries (`uses_from_macos`) are excluded.

2. **Parallel date fetch** — once the full dependency tree is resolved, brewview queries the GitHub commits API for each formula's Ruby source file in homebrew-core to determine when that formula's version was last bumped. All requests fire concurrently to minimise latency.

## Output columns

| Column | Description |
|---|---|
| Package | Formula name (links to formulae.brew.sh) |
| Version | Current stable version |
| Updated | Date the formula was last updated in homebrew-core |
| Installs/year | Total installs over the past 365 days (all versions combined) |

### Color coding

| Color | Column | Meaning |
|---|---|---|
| Red | Updated | Formula updated within the last 7 days |
| Yellow | Updated | Formula updated within the last 8–30 days |

Click any column header to sort by that column. Clicking an active header toggles between ascending and descending. Null values always sort to the bottom.

## Result summary

The summary line above the table shows:

- **Total** — all packages in the resolved tree
- **Root** — the formula you searched for (depth 0)
- **Direct** — packages listed as a direct dependency of the root (depth 1)
- **Transitive** — packages pulled in by a dependency of a dependency (depth 2+)

## Rate limits

The GitHub commits API allows 60 unauthenticated requests per hour. Large dependency trees (e.g. `ffmpeg`) may exhaust this limit; affected packages will simply show no updated date rather than failing.

## Running tests

```bash
npm test
```
