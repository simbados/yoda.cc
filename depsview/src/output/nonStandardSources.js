/**
 * Pure data utilities for non-standard package source detection.
 * No HTML building here — rendering lives in the consumer (reportGenerator.js
 * for HTML reports, web/app.js for the browser UI).
 */

/**
 * Extracts the hostname from a URL string, falling back to the first path
 * segment for non-URL values (e.g. Go module paths like "corp.internal/pkg").
 * @param {string} str
 * @returns {string}
 */
export function domainOf(str) {
  try {
    return new URL(str).hostname;
  } catch {
    const first = str.split("/")[0];
    // Reject bare relative-path segments (., ..) that are not valid domain labels.
    return /^\.\.?$/.test(first) ? str : first;
  }
}

/**
 * Groups an array of private packages by their source domain.
 * @param {Array<{ name: string, url: string }>} privatePkgs
 * @returns {Map<string, string[]>} domain → package names
 */
export function groupByDomain(privatePkgs) {
  const map = new Map();
  for (const pkg of privatePkgs) {
    const domain = domainOf(pkg.url);
    if (!map.has(domain)) map.set(domain, []);
    map.get(domain).push(pkg.name);
  }
  return map;
}
