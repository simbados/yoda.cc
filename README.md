# yoda.cc

Monorepo for [yoda.cc](https://yoda.cc) — a collection of browser-based developer tools.

## Directories

| Directory | Description |
|-----------|-------------|
| [`brewview/`](brewview/) | Homebrew dependency viewer — resolves and displays formula and cask dependency trees from the Homebrew registry (`formulae.brew.sh`) |
| [`depsview/`](depsview/) | Multi-ecosystem dependency viewer — analyses Python, npm, and Go dependencies from any public GitHub repository or by package name |
| [`landing/`](landing/) | Landing page served at the root domain (`yoda.cc`) |
| [`shared/`](shared/) | Shared assets — `style.css` is symlinked into `brewview/web/` and `depsview/web/` so both tools share one stylesheet |
| [`worker/`](worker/) | Cloudflare Worker — CORS proxy for the socket.dev PURL API, deployed at `socket-proxy.yoda.cc` |
