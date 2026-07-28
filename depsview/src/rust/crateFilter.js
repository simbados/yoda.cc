/**
 * Utilities for filtering Cargo packages by whether they are publicly
 * resolvable via the crates.io JSON API.
 *
 * A `[[package]]` entry in `Cargo.lock` is considered **public** when its
 * `source` field starts with one of the two crates.io URLs:
 *
 *   registry+https://github.com/rust-lang/crates.io-index    (legacy git index)
 *   sparse+https://index.crates.io/                           (since Cargo 1.70)
 *
 * Anything else is private or non-standard:
 *   - `git+…`         — git dependency (not on a registry)
 *   - `registry+…`    — alternative registry (corporate / internal)
 *   - `sparse+…`      — non-crates.io sparse index
 *   - `path+…`        — local path replacement
 *   - source omitted  — workspace member or the project itself; not resolvable
 *
 * Public-vs-private packages are surfaced separately so the formatter can show
 * a skipped-count note and the non-standard-sources block.
 */

import { isCratesIoSource } from "./parserCore.js";

/**
 * Returns true when a Cargo.lock `source` field points at the public
 * crates.io registry.
 * @param {string|null|undefined} source
 * @returns {boolean}
 */
export function isPublicCratesIo(source) {
  return isCratesIoSource(source);
}

/**
 * Splits a list of Cargo packages into public (crates.io) and private buckets.
 *
 * Packages with `source === null` are treated as private because they have no
 * resolvable origin — typically the workspace member representing the project
 * itself, which we do not want to look up against crates.io. They are also
 * not included in the "private packages skipped" non-standard-sources block
 * because they are local, not third-party; instead they are silently dropped.
 *
 * Does not mutate the input array.
 *
 * @param {Array<{ name: string, version: string, source: string|null }>} packages
 * @returns {{
 *   publicPkgs:   Array<{ name: string, version: string, source: string }>,
 *   privateCount: number,
 *   privatePkgs:  Array<{ name: string, url: string }>
 * }}
 */
export function partitionCargoPackages(packages) {
  const publicPkgs = [];
  const privatePkgs = [];

  for (const pkg of packages) {
    if (isPublicCratesIo(pkg.source)) {
      publicPkgs.push(pkg);
    } else if (pkg.source) {
      privatePkgs.push({ name: pkg.name, url: pkg.source });
    }
    // Packages with no source (workspace members / the project itself) are
    // silently dropped — they cannot be looked up against crates.io.
  }

  return { publicPkgs, privateCount: privatePkgs.length, privatePkgs };
}
