import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCodePoint,
  detectInvisibleChars,
  hasDangerousChars,
  isEmojiBase,
  isVariationSelector,
  isCombiningMark,
  SEVERITY,
} from '../../src/lib/security/unicodeSafety.js';

describe('classifyCodePoint', () => {
  it('null byte is DENY', () => {
    assert.equal(classifyCodePoint(0x0000).severity, SEVERITY.DENY);
  });

  it('Bidi RLO (U+202E) is DENY', () => {
    assert.equal(classifyCodePoint(0x202e).severity, SEVERITY.DENY);
  });

  it('Bidi LRI (U+2066) is DENY', () => {
    assert.equal(classifyCodePoint(0x2066).severity, SEVERITY.DENY);
  });

  it('Isolated Surrogate (U+D800) is DENY', () => {
    assert.equal(classifyCodePoint(0xd800).severity, SEVERITY.DENY);
    assert.equal(classifyCodePoint(0xd800).label, 'Isolated Surrogate');
  });

  it('Isolated Surrogate (U+DFFF) is DENY', () => {
    assert.equal(classifyCodePoint(0xdfff).severity, SEVERITY.DENY);
  });

  it('Zero Width Space (U+200B) is WARN', () => {
    assert.equal(classifyCodePoint(0x200b).severity, SEVERITY.WARN);
  });

  it('Soft Hyphen (U+00AD) is WARN', () => {
    assert.equal(classifyCodePoint(0x00ad).severity, SEVERITY.WARN);
  });

  it('control char U+0001 is WARN', () => {
    assert.equal(classifyCodePoint(0x0001).severity, SEVERITY.WARN);
  });

  it('C1 control NEL (U+0085) is WARN', () => {
    assert.equal(classifyCodePoint(0x0085).severity, SEVERITY.WARN);
  });

  it('C1 control CSI (U+009B) is WARN', () => {
    assert.equal(classifyCodePoint(0x009b).severity, SEVERITY.WARN);
  });

  it('tab (U+0009) is ALLOW', () => {
    assert.equal(classifyCodePoint(0x0009).severity, SEVERITY.ALLOW);
  });

  it('LF (U+000A) is ALLOW', () => {
    assert.equal(classifyCodePoint(0x000a).severity, SEVERITY.ALLOW);
  });

  it('CR (U+000D) is ALLOW', () => {
    assert.equal(classifyCodePoint(0x000d).severity, SEVERITY.ALLOW);
  });

  it('regular ASCII letter is ALLOW', () => {
    assert.equal(classifyCodePoint(0x0041).severity, SEVERITY.ALLOW);
  });

  it('full-width space (U+3000) is ALLOW', () => {
    assert.equal(classifyCodePoint(0x3000).severity, SEVERITY.ALLOW);
  });

  // BIDI_DENY — all 9 entries
  it('Bidi LRE (U+202A) is DENY', () =>
    assert.equal(classifyCodePoint(0x202a).severity, SEVERITY.DENY));
  it('Bidi RLE (U+202B) is DENY', () =>
    assert.equal(classifyCodePoint(0x202b).severity, SEVERITY.DENY));
  it('Bidi PDF (U+202C) is DENY', () =>
    assert.equal(classifyCodePoint(0x202c).severity, SEVERITY.DENY));
  it('Bidi LRO (U+202D) is DENY', () =>
    assert.equal(classifyCodePoint(0x202d).severity, SEVERITY.DENY));
  it('Bidi RLI (U+2067) is DENY', () =>
    assert.equal(classifyCodePoint(0x2067).severity, SEVERITY.DENY));
  it('Bidi FSI (U+2068) is DENY', () =>
    assert.equal(classifyCodePoint(0x2068).severity, SEVERITY.DENY));
  it('Bidi PDI (U+2069) is DENY', () =>
    assert.equal(classifyCodePoint(0x2069).severity, SEVERITY.DENY));

  it('Delete (U+007F) is WARN', () =>
    assert.equal(classifyCodePoint(0x007f).severity, SEVERITY.WARN));

  // C1 control char boundaries
  it('C1 control lower boundary (U+0080) is WARN', () =>
    assert.equal(classifyCodePoint(0x0080).severity, SEVERITY.WARN));
  it('C1 control upper boundary (U+009F) is WARN', () =>
    assert.equal(classifyCodePoint(0x009f).severity, SEVERITY.WARN));

  // INVISIBLE_WARN — all 7 entries
  it('ZWNJ (U+200C) is WARN', () =>
    assert.equal(classifyCodePoint(0x200c).severity, SEVERITY.WARN));
  it('ZWJ (U+200D) is WARN', () => assert.equal(classifyCodePoint(0x200d).severity, SEVERITY.WARN));
  it('Word Joiner (U+2060) is WARN', () =>
    assert.equal(classifyCodePoint(0x2060).severity, SEVERITY.WARN));
  it('NBSP (U+00A0) is WARN', () =>
    assert.equal(classifyCodePoint(0x00a0).severity, SEVERITY.WARN));
  it('BOM (U+FEFF) is WARN', () => assert.equal(classifyCodePoint(0xfeff).severity, SEVERITY.WARN));
});

describe('detectInvisibleChars', () => {
  it('detects Zero Width Space in body text', () => {
    const findings = detectInvisibleChars('hello​world');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].codePoint, 0x200b);
    assert.equal(findings[0].severity, SEVERITY.WARN);
  });

  it('detects Bidi RLO as DENY', () => {
    const findings = detectInvisibleChars('abc‮def');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, SEVERITY.DENY);
    assert.equal(findings[0].codePoint, 0x202e);
  });

  it('does NOT warn for CR in CRLF (Windows line endings)', () => {
    const findings = detectInvisibleChars('line1\r\nline2');
    assert.equal(findings.length, 0);
  });

  it('does NOT warn for ⌛ (U+231B, clock emoji, U+2300-23FF range)', () => {
    const findings = detectInvisibleChars('締切⌛');
    assert.equal(findings.length, 0);
  });

  it('does NOT warn for ⭐ (U+2B50, star emoji, U+2B00-2BFF range)', () => {
    const findings = detectInvisibleChars('評価⭐');
    assert.equal(findings.length, 0);
  });

  it('does NOT warn for ZWJ inside emoji sequence (👨‍👩‍👧)', () => {
    // Family emoji: man + ZWJ + woman + ZWJ + girl
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const findings = detectInvisibleChars(family);
    assert.equal(findings.length, 0);
  });

  it('DOES warn for ZWJ not inside emoji sequence', () => {
    const findings = detectInvisibleChars('abc‍def');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].codePoint, 0x200d);
    assert.equal(findings[0].severity, SEVERITY.WARN);
  });

  it('DOES warn for ZWJ between ASCII and emoji (A‍👨 injection)', () => {
    const findings = detectInvisibleChars('A‍\u{1F468}');
    assert.ok(findings.some((f) => f.codePoint === 0x200d && f.severity === SEVERITY.WARN));
  });

  it('DOES warn for ZWJ between digits (1‍2 injection)', () => {
    // 0-9 are keycap bases (valid for VS16) but NOT ZWJ sequence members
    const findings = detectInvisibleChars('1‍2');
    assert.ok(findings.some((f) => f.codePoint === 0x200d && f.severity === SEVERITY.WARN));
  });

  it('DOES warn for ZWJ between © and ® (©‍® injection)', () => {
    const findings = detectInvisibleChars('©‍®');
    assert.ok(findings.some((f) => f.codePoint === 0x200d && f.severity === SEVERITY.WARN));
  });

  it('does NOT warn for ❤️‍🔥 (Heart + VS16 + ZWJ + Fire)', () => {
    // ❤️‍🔥 = U+2764 + U+FE0F + U+200D + U+1F525
    const heartOnFire = '❤️‍\u{1F525}';
    const findings = detectInvisibleChars(heartOnFire);
    assert.equal(findings.length, 0, `should have no findings, got: ${JSON.stringify(findings)}`);
  });

  it('does NOT warn for 1️⃣ (digit + VS16 + combining keycap)', () => {
    const keycap = '1️⃣';
    const findings = detectInvisibleChars(keycap);
    assert.equal(findings.length, 0);
  });

  it('does NOT warn for ©️ (copyright + VS16)', () => {
    const copyrightEmoji = '©️';
    const findings = detectInvisibleChars(copyrightEmoji);
    assert.equal(findings.length, 0);
  });

  it('does NOT warn for Variation Selector in ❤️ (U+2764 + U+FE0F)', () => {
    const heartEmoji = '❤️';
    const findings = detectInvisibleChars(heartEmoji);
    assert.equal(findings.length, 0);
  });

  it('DOES warn for Variation Selector not after emoji', () => {
    const findings = detectInvisibleChars('A️');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, SEVERITY.WARN);
  });

  it('does NOT warn for normal French diacritic é (U+0065 + U+0301)', () => {
    // NFD form: e + combining acute
    const findings = detectInvisibleChars('é');
    assert.equal(findings.length, 0);
  });

  it('DOES warn for excessive combining marks (zalgo)', () => {
    // 10 combining marks in a row
    const zalgo = 'a' + '̀'.repeat(10);
    const findings = detectInvisibleChars(zalgo);
    assert.ok(findings.length > 0);
    assert.ok(findings.some((f) => f.label.startsWith('Excessive Combining Marks')));
  });

  it('does NOT warn for 3 combining marks (below threshold)', () => {
    const str = 'a' + '̀'.repeat(3);
    const findings = detectInvisibleChars(str);
    assert.equal(findings.length, 0);
  });

  it('does NOT warn when combining run is split by ZWJ (CM×3 + ZWJ + CM×3 should not combine to 6)', () => {
    // Each run is 3 marks → each is ≤5 → no Excessive Combining Marks warning
    // ZWJ itself is flagged (WARN) since it's between combining marks, not emoji
    const str = 'a' + '̀'.repeat(3) + '‍' + 'b' + '̀'.repeat(3);
    const findings = detectInvisibleChars(str);
    assert.ok(
      !findings.some((f) => f.label.startsWith('Excessive Combining Marks')),
      'should not report excessive combining marks',
    );
    assert.ok(
      findings.some((f) => f.codePoint === 0x200d && f.severity === SEVERITY.WARN),
      'ZWJ between non-emoji should still be warned',
    );
  });

  it('handles surrogate-pair emoji without error', () => {
    // 🍕 is U+1F355, uses surrogate pairs in UTF-16
    const str = 'ピザ🍕テスト';
    assert.doesNotThrow(() => detectInvisibleChars(str));
    assert.equal(detectInvisibleChars(str).length, 0);
  });

  it('returns empty array for clean string', () => {
    assert.deepEqual(detectInvisibleChars('普通のテキスト。\nタブ\t改行'), []);
  });

  it('returns empty array for non-string input', () => {
    assert.deepEqual(detectInvisibleChars(null), []);
    assert.deepEqual(detectInvisibleChars(undefined), []);
    assert.deepEqual(detectInvisibleChars(42), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(detectInvisibleChars(''), []);
  });

  it('DOES warn for ZWJ at string end (no following emoji)', () => {
    const findings = detectInvisibleChars('abc‍');
    assert.ok(findings.some((f) => f.codePoint === 0x200d && f.severity === SEVERITY.WARN));
  });

  it('DOES warn for VS16 at string start (no preceding emoji)', () => {
    const findings = detectInvisibleChars('️abc');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, SEVERITY.WARN);
  });

  it('detects BOM (U+FEFF) as WARN', () => {
    const findings = detectInvisibleChars('﻿ftext');
    assert.ok(findings.some((f) => f.codePoint === 0xfeff && f.severity === SEVERITY.WARN));
  });

  it('detects Word Joiner (U+2060) as WARN', () => {
    const findings = detectInvisibleChars('abc⁠def');
    assert.ok(findings.some((f) => f.codePoint === 0x2060 && f.severity === SEVERITY.WARN));
  });
});

describe('isEmojiBase', () => {
  it('‼ (U+203C) is emoji base', () => assert.ok(isEmojiBase(0x203c)));
  it('⁉ (U+2049) is emoji base', () => assert.ok(isEmojiBase(0x2049)));
  it('™ (U+2122) is emoji base', () => assert.ok(isEmojiBase(0x2122)));
  it('ℹ (U+2139) is emoji base', () => assert.ok(isEmojiBase(0x2139)));
  it('↔ (U+2194) is emoji base', () => assert.ok(isEmojiBase(0x2194)));
  it('↙ (U+2199) is emoji base', () => assert.ok(isEmojiBase(0x2199)));
  it('↩ (U+21A9) is emoji base', () => assert.ok(isEmojiBase(0x21a9)));
  it('↪ (U+21AA) is emoji base', () => assert.ok(isEmojiBase(0x21aa)));
  it('⤴ (U+2934) is emoji base', () => assert.ok(isEmojiBase(0x2934)));
  it('⤵ (U+2935) is emoji base', () => assert.ok(isEmojiBase(0x2935)));
  it('〰 (U+3030) is emoji base', () => assert.ok(isEmojiBase(0x3030)));
  it('〽 (U+303D) is emoji base', () => assert.ok(isEmojiBase(0x303d)));
  it('㊗ (U+3297) is emoji base', () => assert.ok(isEmojiBase(0x3297)));
  it('㊙ (U+3299) is emoji base', () => assert.ok(isEmojiBase(0x3299)));
  it('SMP emoji 🌸 (U+1F338) is emoji base', () => assert.ok(isEmojiBase(0x1f338)));
  it('⌛ (U+231B) in range 2300-27FF is emoji base', () => assert.ok(isEmojiBase(0x231b)));
  it('⭐ (U+2B50) in range 2B00-2BFF is emoji base', () => assert.ok(isEmojiBase(0x2b50)));
  it('0 (U+0030) is emoji base (keycap base)', () => assert.ok(isEmojiBase(0x30)));
  it('9 (U+0039) is emoji base (keycap base)', () => assert.ok(isEmojiBase(0x39)));
  it('* (U+002A) is emoji base (keycap base)', () => assert.ok(isEmojiBase(0x2a)));
  it('# (U+0023) is emoji base (keycap base)', () => assert.ok(isEmojiBase(0x23)));
  it('© (U+00A9) is emoji base', () => assert.ok(isEmojiBase(0xa9)));
  it('® (U+00AE) is emoji base', () => assert.ok(isEmojiBase(0xae)));
  it('regular ASCII letter A (U+0041) is NOT emoji base', () => assert.ok(!isEmojiBase(0x41)));
  it('U+2100 (℀) is NOT emoji base', () => assert.ok(!isEmojiBase(0x2100)));

  it('does NOT warn for ‼️ (U+203C + VS16)', () => {
    const findings = detectInvisibleChars('‼️');
    assert.equal(findings.length, 0);
  });
  it('does NOT warn for ™️ (U+2122 + VS16)', () => {
    const findings = detectInvisibleChars('™️');
    assert.equal(findings.length, 0);
  });
  it('does NOT warn for ↩️ (U+21A9 + VS16)', () => {
    const findings = detectInvisibleChars('↩️');
    assert.equal(findings.length, 0);
  });
  it('does NOT warn for ⤴️ (U+2934 + VS16)', () => {
    const findings = detectInvisibleChars('⤴️');
    assert.equal(findings.length, 0);
  });
  it('does NOT warn for 〰️ (U+3030 + VS16)', () => {
    const findings = detectInvisibleChars('〰️');
    assert.equal(findings.length, 0);
  });
});

describe('isVariationSelector', () => {
  it('VS1 (U+FE00) is variation selector', () => assert.ok(isVariationSelector(0xfe00)));
  it('VS16 (U+FE0F) is variation selector', () => assert.ok(isVariationSelector(0xfe0f)));
  it('SMP VS (U+E0100) is variation selector', () => assert.ok(isVariationSelector(0xe0100)));
  it('SMP VS last (U+E01EF) is variation selector', () => assert.ok(isVariationSelector(0xe01ef)));
  it('regular letter (U+0041) is NOT variation selector', () =>
    assert.ok(!isVariationSelector(0x41)));
});

describe('isCombiningMark', () => {
  it('U+0300 (range 0300-036F start) is combining mark', () => assert.ok(isCombiningMark(0x0300)));
  it('U+036F (range 0300-036F end) is combining mark', () => assert.ok(isCombiningMark(0x036f)));
  it('U+1AB0 (range 1AB0-1AFF) is combining mark', () => assert.ok(isCombiningMark(0x1ab0)));
  it('U+1DC0 (range 1DC0-1DFF) is combining mark', () => assert.ok(isCombiningMark(0x1dc0)));
  it('U+20D0 (range 20D0-20FF) is combining mark', () => assert.ok(isCombiningMark(0x20d0)));
  it('U+FE20 (range FE20-FE2F) is combining mark', () => assert.ok(isCombiningMark(0xfe20)));
  it('regular letter (U+0041) is NOT combining mark', () => assert.ok(!isCombiningMark(0x41)));
});

describe('hasDangerousChars', () => {
  it('returns true when Bidi char present', () => {
    assert.equal(hasDangerousChars('hello‮world'), true);
  });

  it('returns false for WARN-only content', () => {
    assert.equal(hasDangerousChars('hello​world'), false);
  });

  it('returns false for clean string', () => {
    assert.equal(hasDangerousChars('clean text'), false);
  });
});
