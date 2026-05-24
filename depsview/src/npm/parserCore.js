/**
 * Pure package.json dependency parser — no Node.js imports.
 * Browser-compatible. Filesystem operations live in npm/parser.js.
 */

/**
 * Returns true when a version spec string refers to a non-registry source
 * that cannot be resolved from the npm registry: local paths (file:, link:),
 * workspace references, git URLs, and bare relative paths.
 * @param {string|unknown} spec
 * @returns {boolean}
 */
function isNonRegistrySpec(spec) {
  if (typeof spec !== 'string') return true;
  return /^(file:|link:|workspace:|git\+|git:|github:|https?:|[./])/.test(spec.trim());
}

/**
 * Returns a human-readable reason string for a non-registry npm spec.
 * @param {string} spec
 * @returns {string}
 */
function specReason(spec) {
  const s = String(spec).trim();
  if (/^(file:|link:|\.\.?[/\\])/.test(s)) return 'local path';
  if (/^(git\+|git:|github:)/.test(s))     return 'git reference';
  if (/^https?:/.test(s))                  return 'direct URL';
  return 'non-registry spec';
}

/**
 * Parses a package.json content string into regular deps and non-registry specs.
 * Always reads `dependencies`; reads `devDependencies` only when includeTests is true.
 * Workspace references (`workspace:`) are silently skipped — they are a monorepo
 * tool detail, not a security concern. All other non-registry specs (file:, git+,
 * github:, https:, relative paths) are collected in `dangerousDeps` so the caller
 * can surface them to the user.
 * @param {string} content - raw package.json content
 * @param {boolean} includeTests - when true, devDependencies are included
 * @returns {{ deps: Array<{ name: string, versionSpec: string|null }>, dangerousDeps: Array<{ name: string, spec: string, reason: string }> }}
 */
function parsePackageJson(content, includeTests = false) {
  const data = JSON.parse(content);
  const deps = [];
  const dangerousDeps = [];

  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, spec] of Object.entries(obj)) {
      if (!isNonRegistrySpec(spec)) {
        deps.push({ name, versionSpec: String(spec).trim() || null });
      } else if (!/^workspace:/.test(String(spec).trim())) {
        dangerousDeps.push({ name, spec: String(spec), reason: specReason(spec) });
      }
    }
  };

  collect(data.dependencies);
  if (includeTests) collect(data.devDependencies);

  return { deps, dangerousDeps };
}

export { parsePackageJson, isNonRegistrySpec };
