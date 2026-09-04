import {
  SEVERITY,
  classifyCodePoint,
  isVariationSelector,
  isCombiningMark,
} from './unicodeSafety.js';

// Remove ZWJ, ZWNJ, VS, combining marks, path separators, and control chars invalid in file names
function shouldSkipInFileName(cp) {
  if (cp === 0x200d || cp === 0x200c) return true;
  if (isVariationSelector(cp)) return true;
  if (isCombiningMark(cp)) return true;
  if (cp === 0x2f || cp === 0x5c) return true;
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  return false;
}

// Slice by code point count to avoid splitting surrogate pairs
function sliceByCodePoint(str, maxLen) {
  let result = '';
  let count = 0;
  for (const ch of str) {
    if (count >= maxLen) break;
    result += ch;
    count++;
  }
  return result.trimEnd();
}

/**
 * Remove dangerous / invisible characters from a file name and enforce max length.
 * - NFC normalizes first to canonicalize NFD sequences
 * - Strips Bidi, Null, control chars, ZWJ, ZWNJ, ZWS, Variation Selectors
 * - Keeps visible emoji, CJK, kana, kanji, etc.
 * - Collapses multiple spaces that result from stripping
 * - Slices by code point count to avoid splitting surrogate pairs
 *
 * @param {string} name
 * @param {number} maxLen
 * @returns {string}
 */
export function sanitizeFileName(name, maxLen = 255) {
  if (typeof name !== 'string') return '';

  // Pre-truncate extreme inputs to avoid O(n) work on malicious payloads
  if (name.length > maxLen * 4) name = name.slice(0, maxLen * 4);

  // NFC first so NFD sequences don't leave orphaned combining marks
  const normalized = name.normalize('NFC');

  const result = [];

  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (shouldSkipInFileName(cp)) continue;
    const { severity } = classifyCodePoint(cp);
    if (severity === SEVERITY.DENY) continue;
    if (severity === SEVERITY.WARN) {
      // Keep NBSP as a plain space, all other WARN chars dropped
      if (cp === 0x00a0) result.push(' ');
      continue;
    }
    result.push(ch);
  }

  // Collapse consecutive spaces and trim, then slice by code point.
  // for...of iterates code points (handles surrogate pairs as one char) without O(n) array allocation.
  const joined = result.join('').replace(/ +/g, ' ').trim();
  const sliced = sliceByCodePoint(joined, maxLen);
  // '.' and '..' are reserved path components and must not be returned as file names
  if (sliced === '.' || sliced === '..') return '';
  return sliced;
}

/**
 * Returns true if the name contains no dangerous or invisible characters.
 * Does not enforce length limits — length validation is a separate concern.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidFileName(name) {
  // 1020 UTF-16 code units = 255 code points × 4 (generous DoS guard; UTF-16 real max is ×2=510, extra headroom for combining marks/VS)
  if (typeof name !== 'string' || name.length === 0 || name.length > 1020) return false;
  const normalized = name.normalize('NFC');
  return sanitizeFileName(name, 1020) === normalized;
}
