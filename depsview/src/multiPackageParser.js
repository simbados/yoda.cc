/**
 * Multi-package input parser for the web UI textarea.
 * Splits a free-form text field containing one or more package identifiers into
 * individual { name, version } entries suitable for the per-ecosystem dep resolvers.
 *
 * Supported separator formats (in priority order):
 *   1. Commas — with or without surrounding whitespace: "eslint, eslint@9" or "eslint,eslint@9"
 *   2. Newlines — one package per line
 *   3. Any other character flanked by at least one space on each side: "eslint | eslint@8"
 *
 * Characters that are never treated as separators (valid inside package identifiers):
 *   word chars [a-zA-Z0-9_], @, ., -, /, =, >, <, ~, !, +
 * This prevents Go module paths (github.com/owner/repo), Python version specifiers
 * (requests>=2.0), and scoped npm packages (@babel/core) from being split incorrectly.
 */

import { parsePackageInput } from "./packageInput.js";

/**
 * Splits raw multi-package text into individual trimmed token strings.
 * Handles commas, newlines, and any non-package character flanked by spaces.
 * Empty tokens (from trailing separators, blank lines, etc.) are discarded.
 * @param {string} rawText
 * @returns {string[]}
 */
export function splitPackageTokens(rawText) {
  const text = String(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Commas separate entries; \s* on both sides also consumes any surrounding
  // whitespace including newlines, so "eslint,\neslint@9" works correctly.
  const commaSplit = text.split(/\s*,\s*/);

  // After comma-splitting, newlines still separate any remaining adjacent entries.
  const lines = commaSplit.flatMap((chunk) => chunk.split(/\n+/));

  // A non-package character flanked by at least one space on each side is a separator.
  // The character set [^\w@.\-\/=><~!+\s] matches anything that is NOT a word char,
  // @, ., -, /, =, >, <, ~, !, +, or whitespace.
  const spacedSep = /\s+[^\w@.\-\/=><~!+\s]+\s+/g;
  const tokens = lines.flatMap((line) => line.split(spacedSep));

  return tokens
    .map((t) => t.trim().replace(/^[^\w@.\-\/=><~!+]+|[^\w@.\-\/=><~!+]+$/g, ""))
    .filter(Boolean);
}

/**
 * Parses a free-form multi-package textarea value into an array of { name, version } entries.
 * Splits the input with splitPackageTokens, then delegates each token to parsePackageInput
 * for ecosystem-specific name/version extraction.
 * Returns an empty array when the input is blank or contains only separator characters.
 * @param {string} rawText - raw user input from the package textarea
 * @param {'npm'|'python'|'go'} ecosystem
 * @returns {Array<{ name: string, version: string|null }>}
 */
export function parseMultiPackageInput(rawText, ecosystem) {
  const tokens = splitPackageTokens(rawText);
  return tokens.map((token) => parsePackageInput(token, ecosystem));
}
