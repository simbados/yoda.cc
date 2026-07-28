#!/usr/bin/env node
/*
 * Keeps SEO-adjacent metadata in sync with the HTML it describes.
 *
 * For each tracked page (landing, depsview web, brewview web):
 *   1. Bump the matching sitemap's <lastmod> to today's date (UTC, YYYY-MM-DD).
 *   2. Re-extract the JSON-LD block from the HTML, compute its base64 SHA-256,
 *      and replace the existing 'sha256-…' token in the matching _headers CSP
 *      script-src directive so the strict CSP keeps validating.
 *
 * Two run modes:
 *   --pre-commit   Only act on pages whose HTML is staged; re-stage rewritten
 *                  sitemap and _headers files. Invoked by .githooks/pre-commit.
 *   (no flag)      Process all pages unconditionally — useful for ad-hoc resync.
 *
 * Idempotent: if a sitemap's <lastmod> already equals today or a hash already
 * matches the current JSON-LD, the file is not rewritten.
 *
 * No third-party dependencies (vanilla Node only) per repo-wide rule.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const PAGES = [
  {
    html: "landing/index.html",
    sitemap: "landing/pages.xml",
    headers: "landing/_headers",
  },
  {
    html: "depsview/web/index.html",
    sitemap: "depsview/web/sitemap.xml",
    headers: "depsview/web/_headers",
  },
  {
    html: "brewview/web/index.html",
    sitemap: "brewview/web/sitemap.xml",
    headers: "brewview/web/_headers",
  },
];

/**
 * Return today's date as YYYY-MM-DD in UTC. Used for sitemap <lastmod>.
 * @returns {string}
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Return the set of file paths (relative to repo root) currently staged for
 * commit, restricted to added/copied/modified/renamed entries.
 * @returns {Set<string>}
 */
function stagedFiles() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" });
  return new Set(out.split("\n").filter(Boolean));
}

/**
 * Rewrite every <lastmod>…</lastmod> in a sitemap urlset to the given date.
 * @param {string} sitemapPath - absolute path to the sitemap XML file
 * @param {string} date - YYYY-MM-DD date string
 * @returns {boolean} true if the file was modified
 */
function bumpLastmod(sitemapPath, date) {
  const orig = fs.readFileSync(sitemapPath, "utf8");
  const updated = orig.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${date}</lastmod>`);
  if (updated === orig) return false;
  fs.writeFileSync(sitemapPath, updated);
  return true;
}

/**
 * Extract the inner text of the first <script type="application/ld+json"> tag
 * in the given HTML file. Returns null if no such block exists.
 * @param {string} htmlPath - absolute path to the HTML file
 * @returns {string|null}
 */
function extractJsonLd(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

/**
 * Compute the base64-encoded SHA-256 of a UTF-8 string. This is the exact
 * format CSP expects in the 'sha256-…' token.
 * @param {string} s
 * @returns {string}
 */
function sha256base64(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("base64");
}

/**
 * Replace the existing 'sha256-…' token in a CSP `script-src` directive with
 * the given hash. Assumes exactly one such token already exists; warns and
 * returns false if none is found (so a malformed _headers does not crash the
 * commit).
 * @param {string} headersPath - absolute path to the _headers file
 * @param {string} newHash - base64 SHA-256 (without the 'sha256-' prefix)
 * @returns {boolean} true if the file was modified
 */
function syncCspHash(headersPath, newHash) {
  const orig = fs.readFileSync(headersPath, "utf8");
  const re = /'sha256-[A-Za-z0-9+/=]+'/;
  if (!re.test(orig)) {
    console.warn(`[sync-seo] no 'sha256-…' token found in ${headersPath}; skipping`);
    return false;
  }
  const updated = orig.replace(re, `'sha256-${newHash}'`);
  if (updated === orig) return false;
  fs.writeFileSync(headersPath, updated);
  return true;
}

/**
 * Entry point. Iterates PAGES, applying sitemap and CSP updates, and re-stages
 * touched files when running in --pre-commit mode.
 */
function main() {
  const preCommit = process.argv.includes("--pre-commit");
  const staged = preCommit ? stagedFiles() : null;
  const date = today();
  const touched = [];

  for (const page of PAGES) {
    const shouldProcess = !preCommit || staged.has(page.html);
    if (!shouldProcess) continue;

    if (bumpLastmod(path.join(REPO_ROOT, page.sitemap), date)) {
      touched.push(page.sitemap);
    }

    const inner = extractJsonLd(path.join(REPO_ROOT, page.html));
    if (inner == null) {
      console.warn(`[sync-seo] no JSON-LD block in ${page.html}; skipping CSP hash`);
      continue;
    }
    const hash = sha256base64(inner);
    if (syncCspHash(path.join(REPO_ROOT, page.headers), hash)) {
      touched.push(page.headers);
    }
  }

  if (!touched.length) {
    if (!preCommit) console.log("[sync-seo] already in sync");
    return;
  }

  if (preCommit) {
    execSync(`git add ${touched.map((p) => JSON.stringify(p)).join(" ")}`, { stdio: "inherit" });
    console.log(`[sync-seo] updated and re-staged: ${touched.join(", ")}`);
  } else {
    console.log(`[sync-seo] updated: ${touched.join(", ")}`);
  }
}

main();
