/**
 * Node.js-specific wrapper for Rust / Cargo project dependency parsing.
 * Pure string-parsing functions live in parserCore.js (browser-compatible).
 * This module adds file-system operations: reading Cargo.lock / Cargo.toml from
 * a local project directory.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCargoLock, parseCargoToml, normalizeCrateName } from "./parserCore.js";
import { partitionCargoPackages } from "./crateFilter.js";

/**
 * Detects and parses the Cargo dependency file in a given project directory.
 * Priority order: Cargo.lock (preferred, full transitive closure with exact
 * versions) → Cargo.toml (declared direct deps, resolved via a recursive
 * crates.io crawl by the resolver).
 *
 * Cargo.toml is always read for non-registry dependency declarations
 * (`git = …`, `path = …`, `registry = …`); these are surfaced as
 * `dangerousDeps` regardless of which file drives resolution.
 *
 * Each returned dep is shaped for the resolver:
 *   - Cargo.lock: `{ name, version, source }` (exact — lockfile mode)
 *   - Cargo.toml: `{ name, versionSpec }`     (constraint — manifest mode)
 *
 * @param {string} projectPath - absolute path to the Rust project root
 * @param {{ includeTests?: boolean }} [options] - includeTests pulls in
 *   `[dev-dependencies]` when Cargo.toml is the source (Cargo.lock always
 *   enumerates the full closure, so the flag has no effect there)
 * @returns {{
 *   deps: Array<{ name: string, version?: string, source?: string|null, versionSpec?: string|null }>,
 *   source: string,
 *   privateCount: number,
 *   privatePkgs: Array<{ name: string, url: string }>,
 *   dangerousDeps: Array<{ name: string, spec: string, reason: string }>
 * }}
 * @throws {Error} when neither Cargo.lock nor Cargo.toml is present
 */
export function parseDependencyFile(projectPath, options = {}) {
  const { includeTests = false } = options;

  // Always read Cargo.toml (when present) for non-registry dependency specs.
  let dangerousDeps = [];
  const cargoTomlPath = path.join(projectPath, "Cargo.toml");
  const hasCargoToml = fs.existsSync(cargoTomlPath) && !fs.statSync(cargoTomlPath).isDirectory();
  if (hasCargoToml) {
    try {
      dangerousDeps = parseCargoToml(
        fs.readFileSync(cargoTomlPath, "utf8"),
        includeTests,
      ).dangerousDeps;
    } catch {
      /* ignore — dangerous-dep parsing is best-effort */
    }
  }

  // Cargo.lock preferred: full transitive closure with exact pinned versions.
  const lockPath = path.join(projectPath, "Cargo.lock");
  if (fs.existsSync(lockPath) && !fs.statSync(lockPath).isDirectory()) {
    try {
      const packages = parseCargoLock(fs.readFileSync(lockPath, "utf8"));
      const { publicPkgs, privateCount, privatePkgs } = partitionCargoPackages(packages);
      return { deps: publicPkgs, source: "Cargo.lock", privateCount, privatePkgs, dangerousDeps };
    } catch (err) {
      throw new Error(`Failed to parse Cargo.lock: ${err.message}`);
    }
  }

  // Cargo.toml fallback: declared deps resolved by a recursive crates.io crawl.
  if (hasCargoToml) {
    try {
      const { deps } = parseCargoToml(fs.readFileSync(cargoTomlPath, "utf8"), includeTests);
      return { deps, source: "Cargo.toml", privateCount: 0, privatePkgs: [], dangerousDeps };
    } catch (err) {
      throw new Error(`Failed to parse Cargo.toml: ${err.message}`);
    }
  }

  throw new Error(
    `No Rust dependency file found in ${projectPath}. Looked for: Cargo.lock, Cargo.toml`,
  );
}

/**
 * Reads Cargo.toml (if present) to determine which crates are direct
 * dependencies. Used alongside Cargo.lock-based resolution to populate the
 * direct/transitive footer, mirroring how npm uses package.json alongside
 * package-lock.json and Go uses go.mod alongside go.sum.
 * Returns an empty Set when Cargo.toml is absent or unparseable.
 * @param {string} dirPath
 * @param {boolean} [includeTests=false] - include `[dev-dependencies]` as direct
 * @returns {Set<string>} normalised crate names that are direct deps
 */
export function readDirectNamesFromCargoToml(dirPath, includeTests = false) {
  try {
    const content = fs.readFileSync(path.join(dirPath, "Cargo.toml"), "utf8");
    const { deps } = parseCargoToml(content, includeTests);
    return new Set(deps.map((d) => normalizeCrateName(d.name)));
  } catch {
    return new Set();
  }
}
