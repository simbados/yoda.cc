# yoda.cc

Monorepo for [yoda.cc](https://yoda.cc) — a collection of browser-based developer tools.

## Directories

| Directory                  | Description                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`brewview/`](brewview/)   | Homebrew dependency viewer — resolves and displays formula and cask dependency trees from the Homebrew registry (`formulae.brew.sh`)         |
| [`depsview/`](depsview/)   | Multi-ecosystem dependency viewer — analyses Python, npm, and Go dependencies from any public GitHub repository or by package name           |
| [`landing/`](landing/)     | Landing page served at the root domain (`yoda.cc`)                                                                                           |
| [`shared/`](shared/)       | Shared assets — `style.css` is symlinked into `brewview/web/` and `depsview/web/` so both tools share one stylesheet                         |
| [`worker/`](worker/)       | Cloudflare Worker — CORS proxy for the socket.dev PURL API, deployed at `socket-proxy.yoda.cc`                                               |
| [`scripts/`](scripts/)     | Repo-wide dev utilities (no runtime dependencies). `sync-seo.js` keeps sitemap `<lastmod>` and JSON-LD CSP hashes in sync with the page HTML |
| [`.githooks/`](.githooks/) | Repo-tracked git hooks. `pre-commit` runs `scripts/sync-seo.js` against staged files                                                         |

## One-time clone setup

Git's default hook location (`.git/hooks/`) is not tracked, so this repo ships its hooks under `.githooks/` and asks each clone to point git at that directory:

```sh
git config core.hooksPath .githooks
```

After that, the `pre-commit` hook automatically bumps the matching sitemap's `<lastmod>` and recomputes the JSON-LD CSP `sha256-…` token in `_headers` whenever an `index.html` is staged. You can also run it manually at any time:

```sh
node scripts/sync-seo.js
```
