/**
 * Utilities for filtering Go modules by whether they are publicly accessible
 * through the Go module proxy (proxy.golang.org).
 *
 * Private modules — those whose paths start with an internal hostname not listed
 * in the public allowlist below — cannot be resolved by depsview and are silently
 * skipped. The allowlist covers all major public Go module hosting services.
 *
 * A module path is considered public when its first path segment (the hostname)
 * matches one of the known public hosts. Everything else — internal domains,
 * corporate hostnames, single-label hostnames — is treated as private.
 */

const PUBLIC_GO_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "golang.org",
  "gopkg.in",
  "k8s.io",
  "sigs.k8s.io",
  "go.uber.org",
  "google.golang.org",
  "cloud.google.com",
  "go.opencensus.io",
  "go.opentelemetry.io",
  "mvdan.cc",
  "honnef.co",
  "filippo.io",
  "mellium.im",
  "nhooyr.io",
  "cel.dev",
  "buf.build",
  "cuelang.org",
  "dario.cat",
  "go.etcd.io",
  "go.mongodb.org",
  "go.temporal.io",
  "gocloud.dev",
  "storj.io",
]);

/**
 * Returns true when a Go module path is publicly accessible via proxy.golang.org.
 * Extracts the hostname from the module path (the first slash-delimited segment)
 * and checks it against the known-public allowlist.
 * @param {string} modulePath - e.g. "github.com/gin-gonic/gin"
 * @returns {boolean}
 */
export function isPublicGoModule(modulePath) {
  if (!modulePath) return false;
  const host = modulePath.split("/")[0];
  return PUBLIC_GO_HOSTS.has(host);
}

/**
 * Splits a list of Go modules into public and private arrays.
 * Private modules are those whose path hostname is not in the public allowlist —
 * typically internal corporate modules or single-label hostnames.
 * Returns `privateMods` with the module path (used as URL equivalent) so callers
 * can surface them to the user.
 * Does not mutate the input array.
 * @param {Array<{ name: string, version: string, indirect?: boolean }>} modules
 * @returns {{
 *   publicMods:   Array<{ name: string, version: string, indirect?: boolean }>,
 *   privateCount: number,
 *   privateMods:  Array<{ name: string, url: string }>
 * }}
 */
export function partitionGoModules(modules) {
  const publicMods = [];
  const privateMods = [];
  for (const mod of modules) {
    if (isPublicGoModule(mod.name)) {
      publicMods.push(mod);
    } else {
      privateMods.push({ name: mod.name, url: mod.name });
    }
  }
  return { publicMods, privateCount: privateMods.length, privateMods };
}
