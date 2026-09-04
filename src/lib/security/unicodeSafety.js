export const SEVERITY = /** @type {const} */ ({
  ALLOW: 'allow',
  WARN: 'warn',
  DENY: 'deny',
});

// Bidi override / isolate: always deny
const BIDI_DENY = new Set([
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e, // LRE RLE PDF LRO RLO
  0x2066,
  0x2067,
  0x2068,
  0x2069, // LRI RLI FSI PDI
]);

// Zero-width and invisible characters to warn.
// rootPath 検証（ROOTPATH_FORBIDDEN_CHAR_RE）の被覆参照集合を兼ねる。#478 で rootPath regex は
// 個別列挙をやめ Unicode カテゴリ（\p{Cf} / \p{Default_Ignorable_Code_Point} 等）で拒否するようになったため、
// 本集合の全要素は現状カテゴリ側で拒否される。rootPathValidationParity.test.js が「本集合の全要素を
// rootPath regex が拒否する」ことを機械検査する＝将来ここへ追加された要素がどのカテゴリにも該当せず
// rootPath regex を素通りする回帰を検出する安全網（本集合を実行時 import しないことは変わらない）。
export const INVISIBLE_WARN = new Set([
  0x200b, // Zero Width Space
  0x200c, // Zero Width Non-Joiner
  0x200d, // Zero Width Joiner (contextual: emoji sequences are handled separately)
  0x2060, // Word Joiner
  0x00ad, // Soft Hyphen
  0x00a0, // No-Break Space
  0xfeff, // BOM / Zero Width No-Break Space
]);

const CHAR_LABELS = {
  0x200b: 'Zero Width Space',
  0x200c: 'Zero Width Non-Joiner',
  0x200d: 'Zero Width Joiner',
  0x2060: 'Word Joiner',
  0x00ad: 'Soft Hyphen',
  0x00a0: 'No-Break Space',
  0xfeff: 'BOM',
  0x0000: 'Null Byte',
  0x007f: 'Delete',
};

export function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

export function isCombiningMark(cp) {
  // Main combining mark blocks
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

// Unicode 15.1 Emoji property — isolated BMP code points not covered by the range checks below
const EMOJI_BMP_SINGLES = new Set([
  0x203c,
  0x2049, // ‼ ⁉
  0x2122,
  0x2139, // ™ ℹ
  0x21a9,
  0x21aa, // ↩ ↪
  0x2934,
  0x2935, // ⤴ ⤵ (gap between U+27FF and U+2B00)
  0x3030,
  0x303d, // 〰 〽
  0x3297,
  0x3299, // ㊗ ㊙
]);

// Exported for direct testing and external callers.
export function isEmojiBase(cp) {
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true; // SMP emoji block
  if (cp >= 0x2300 && cp <= 0x27ff) return true; // Misc Technical / Symbols / Dingbats
  if (cp >= 0x2b00 && cp <= 0x2bff) return true; // Misc Symbols and Arrows
  if (cp >= 0x2194 && cp <= 0x2199) return true; // ↔-↙ arrow emoji (U+21xx gap)
  if (cp >= 0x30 && cp <= 0x39) return true; // 0-9 keycap bases
  if (cp === 0x2a || cp === 0x23) return true; // *, # keycap bases
  if (cp === 0xa9 || cp === 0xae) return true; // ©, ®
  return EMOJI_BMP_SINGLES.has(cp);
}

// ZWJ sequences only join pictographic emoji — keycap bases (0-9, *, #) and
// symbol-only emoji (©, ®) never appear as ZWJ sequence members.
function isEmojiZWJBase(cp) {
  if (cp >= 0x30 && cp <= 0x39) return false;
  if (cp === 0x2a || cp === 0x23) return false;
  if (cp === 0xa9 || cp === 0xae) return false;
  return isEmojiBase(cp);
}

/**
 * Classify a single code point.
 * Returns { severity, label } where severity is SEVERITY.ALLOW/WARN/DENY.
 * Note: ZWJ classification is context-free here (WARN).
 * detectInvisibleChars() applies emoji-sequence context to suppress ZWJ warnings.
 */
export function classifyCodePoint(cp) {
  if (cp === 0x0000) return { severity: SEVERITY.DENY, label: 'Null Byte' };
  if (cp >= 0xd800 && cp <= 0xdfff) return { severity: SEVERITY.DENY, label: 'Isolated Surrogate' };
  if (BIDI_DENY.has(cp)) {
    const names = {
      0x202a: 'LRE',
      0x202b: 'RLE',
      0x202c: 'PDF',
      0x202d: 'LRO',
      0x202e: 'RLO',
      0x2066: 'LRI',
      0x2067: 'RLI',
      0x2068: 'FSI',
      0x2069: 'PDI',
    };
    return {
      severity: SEVERITY.DENY,
      label: `Bidi ${names[cp] ?? 'U+' + cp.toString(16).toUpperCase()}`,
    };
  }
  if (cp === 0x007f) return { severity: SEVERITY.WARN, label: 'Delete' };
  // Control chars: C0 (U+0001–U+001F) except tab/LF/CR, and C1 (U+0080–U+009F)
  if (
    (cp >= 0x0001 && cp <= 0x001f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    (cp >= 0x0080 && cp <= 0x009f)
  ) {
    return {
      severity: SEVERITY.WARN,
      label: `Control U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    };
  }
  if (INVISIBLE_WARN.has(cp)) {
    return {
      severity: SEVERITY.WARN,
      label: CHAR_LABELS[cp] ?? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    };
  }
  return { severity: SEVERITY.ALLOW, label: null };
}

function flushCombiningRun(state, findings) {
  if (state.combiningRun > 0) {
    if (state.combiningRun > 5) {
      findings.push({
        index: state.combiningStart,
        codePoint: -1,
        label: `Excessive Combining Marks (${state.combiningRun})`,
        severity: SEVERITY.WARN,
      });
    }
    state.combiningRun = 0;
    state.combiningStart = -1;
  }
}

// ZWJ: only warn when NOT flanked by ZWJ-capable emoji on BOTH sides (&&)
// Using || would allow undetected ZWJ between text and emoji (e.g. A‍👨)
// isEmojiZWJBase excludes keycap bases (0-9, *, #) and symbol-only emoji (©, ®)
// which are never members of ZWJ sequences (e.g. "1‍2" must be flagged)
function processZwj(state, nextCp, i, findings) {
  flushCombiningRun(state, findings);
  const inEmojiSeq =
    state.prevCp !== null &&
    isEmojiZWJBase(state.prevCp) &&
    nextCp !== null &&
    isEmojiZWJBase(nextCp);
  if (!inEmojiSeq) {
    findings.push({
      index: i,
      codePoint: 0x200d,
      label: 'Zero Width Joiner',
      severity: SEVERITY.WARN,
    });
  }
  state.prevCp = 0x200d;
}

// Variation Selectors: skip inside emoji context
// Do NOT update prevCp so that a VS16 in ❤️‍🔥 doesn't overwrite the emoji base
// before the following ZWJ check
function processVariationSelector(cp, state, i, findings) {
  flushCombiningRun(state, findings);
  const inEmojiSeq = state.prevCp !== null && isEmojiBase(state.prevCp);
  if (!inEmojiSeq) {
    findings.push({
      index: i,
      codePoint: cp,
      label: `Variation Selector U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      severity: SEVERITY.WARN,
    });
  }
  // prevCp intentionally not updated — keep emoji base for subsequent ZWJ detection
}

/**
 * Scan a string for invisible / dangerous characters.
 * Skips ZWJ and Variation Selectors that appear within an emoji sequence.
 * Treats runs of >5 consecutive combining marks as a single WARN entry.
 * Uses codePointAt index loop to avoid O(n) array allocation for large texts.
 *
 * @param {string} str
 * @returns {{ index: number, codePoint: number, label: string, severity: string }[]}
 */
export function detectInvisibleChars(str) {
  if (typeof str !== 'string') return [];

  const findings = [];
  const state = { combiningRun: 0, combiningStart: -1, prevCp: null };

  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    const charLength = cp > 0xffff ? 2 : 1;
    const nextIndex = i + charLength;
    const nextCp = nextIndex < str.length ? str.codePointAt(nextIndex) : null;

    if (cp === 0x200d) {
      processZwj(state, nextCp, i, findings);
      i = nextIndex;
      continue;
    }

    if (isVariationSelector(cp)) {
      processVariationSelector(cp, state, i, findings);
      i = nextIndex;
      continue;
    }

    // Combining marks: accumulate runs, only warn on runs > 5
    if (isCombiningMark(cp)) {
      if (state.combiningRun === 0) state.combiningStart = i;
      state.combiningRun++;
      state.prevCp = cp;
      i = nextIndex;
      continue;
    }

    flushCombiningRun(state, findings);
    const { severity, label } = classifyCodePoint(cp);
    if (severity !== SEVERITY.ALLOW) {
      findings.push({ index: i, codePoint: cp, label, severity });
    }
    state.prevCp = cp;
    i = nextIndex;
  }

  flushCombiningRun(state, findings);
  return findings;
}

/**
 * Returns true if the string contains any DENY-severity characters.
 */
export function hasDangerousChars(str) {
  return detectInvisibleChars(str).some((f) => f.severity === SEVERITY.DENY);
}
