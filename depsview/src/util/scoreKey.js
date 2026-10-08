/**
 * Shared Map key for per-package enrichment data (socket.dev scores, deps.dev findings).
 * Browser-safe — no Node.js imports.
 */

/**
 * Builds the canonical Map key for an ecosystem-tagged package + version pair.
 * Used both when ingesting a provider response and when looking up results from
 * the formatter / report / web UI, so all sides stay aligned.
 *
 * Examples:
 *   scoreKey("npm", "Express", "4.19.2")                        → "npm:express@4.19.2"
 *   scoreKey("golang", "github.com/BurntSushi/toml", "v1.3.2")  → "golang:github.com/burntsushi/toml@v1.3.2"
 *
 * @param {string} ecosystem - PURL type (`npm`, `pypi`, `golang`, `cargo`)
 * @param {string} name      - package name
 * @param {string} version
 * @returns {string}
 */
function scoreKey(ecosystem, name, version) {
  return `${ecosystem}:${name.toLowerCase()}@${version}`;
}

export { scoreKey };
