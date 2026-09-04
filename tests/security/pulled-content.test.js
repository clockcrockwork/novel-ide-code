import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBinary,
  validatePulledContent,
  pullDenyReason,
  pullWarnMessage,
  toSecurityRecord,
  isQuarantined,
  deriveEditedSecurity,
  FILE_CONTENT_MAX,
  OVERSIZE_WARN_CHARS,
} from '../../src/lib/security/validatePulledContent.js';
import { SEVERITY } from '../../src/lib/security/unicodeSafety.js';

describe('detectBinary', () => {
  it('treats plain UTF-8 prose (JP + emoji) as text', () => {
    assert.equal(detectBinary('夜が街に降りてきた。🌙 The night fell.\n\n新しい段落。'), false);
  });

  it('detects null byte as binary', () => {
    assert.equal(detectBinary('hello\x00world'), true);
  });

  it('detects high control-char ratio as binary', () => {
    const blob = '\x01\x02\x03\x04\x05\x06\x07\x08'.repeat(50);
    assert.equal(detectBinary(blob), true);
  });

  it('detects mis-decoded binary via U+FFFD ratio', () => {
    const blob = '�'.repeat(40) + 'text';
    assert.equal(detectBinary(blob), true);
  });

  it('does not flag text with occasional control chars below threshold', () => {
    const text = 'a'.repeat(1000) + '\x07';
    assert.equal(detectBinary(text), false);
  });

  it('returns false for empty string and non-string', () => {
    assert.equal(detectBinary(''), false);
    assert.equal(detectBinary(null), false);
    assert.equal(detectBinary(undefined), false);
  });

  it('does not flag short text where one control char exceeds the ratio (false-positive guard)', () => {
    // 10 文字中 2 個の制御文字 → 比率 20% だが絶対数が下限未満なので text 扱い
    assert.equal(detectBinary('ab\x01cd\x02efgh'), false);
  });
});

describe('validatePulledContent', () => {
  it('allows clean markdown with a clean name', () => {
    const r = validatePulledContent('# 見出し\n\n本文です。', 'chapter.md');
    assert.equal(r.decision, 'allow');
    assert.equal(r.nameChanged, false);
    assert.equal(r.hasDeny, false);
    assert.equal(r.isBinary, false);
    assert.equal(r.safeName, 'chapter.md');
  });

  it('warns (does not deny) on Bidi control characters — open with警告', () => {
    const r = validatePulledContent('safe‮evil.md', 'a.md');
    assert.equal(r.decision, 'warn');
    assert.equal(r.hasDeny, true);
    assert.ok(r.denyFindings.length > 0);
    assert.match(pullWarnMessage(r), /危険な制御文字/);
  });

  it('denies non-string content (invalidType)', () => {
    const r = validatePulledContent({ not: 'a string' }, 'a.md');
    assert.equal(r.decision, 'deny');
    assert.equal(r.invalidType, true);
    assert.match(pullDenyReason(r), /不正な形式/);
  });

  it('denies content with a null byte', () => {
    const r = validatePulledContent('text\x00more', 'a.md');
    assert.equal(r.decision, 'deny');
    // null byte は binary 判定が先に立つ
    assert.ok(r.isBinary || r.hasDeny);
  });

  it('warns on invisible chars only (ZWSP)', () => {
    const r = validatePulledContent('hello​world', 'a.md');
    assert.equal(r.decision, 'warn');
    assert.equal(r.hasDeny, false);
    assert.ok(r.warnSummary);
  });

  it('sanitizes a path-traversal-style name and flags nameChanged', () => {
    const r = validatePulledContent('text', 'a/../b.md');
    assert.equal(r.nameChanged, true);
    assert.equal(r.safeName.includes('/'), false);
    assert.equal(r.decision, 'warn');
  });

  it('denies content larger than FILE_CONTENT_MAX', () => {
    const r = validatePulledContent('a'.repeat(FILE_CONTENT_MAX + 1), 'a.md');
    assert.equal(r.tooLarge, true);
    assert.equal(r.decision, 'deny');
  });

  it('warns when content is between WARN and DENY thresholds', () => {
    const r = validatePulledContent('a'.repeat(OVERSIZE_WARN_CHARS + 10), 'a.md');
    assert.equal(r.oversizeWarn, true);
    assert.equal(r.tooLarge, false);
    assert.equal(r.decision, 'warn');
  });

  it('denies binary content', () => {
    const r = validatePulledContent('\x00\x01\x02\x03'.repeat(20), 'a.md');
    assert.equal(r.isBinary, true);
    assert.equal(r.decision, 'deny');
  });

  it('short-circuits on oversize input without throwing', () => {
    const r = validatePulledContent('a'.repeat(FILE_CONTENT_MAX + 1000), 'a.md');
    // tooLarge 確定時は detectInvisibleChars を呼ばない（hasDeny は false のまま）
    assert.equal(r.hasDeny, false);
    assert.equal(r.decision, 'deny');
  });

  it('falls back to a default name when sanitize yields empty', () => {
    const r = validatePulledContent('text', '..');
    assert.equal(r.safeName, 'ファイル.md');
  });
});

describe('pullDenyReason / pullWarnMessage', () => {
  it('reports the binary reason', () => {
    const r = validatePulledContent('\x00\x01\x02\x03'.repeat(20), 'a.md');
    assert.match(pullDenyReason(r), /バイナリ/);
  });

  it('reports the oversize reason', () => {
    const r = validatePulledContent('a'.repeat(FILE_CONTENT_MAX + 1), 'a.md');
    assert.match(pullDenyReason(r), /大きすぎ/);
  });

  it('builds a warn message including invisible-char detail', () => {
    const r = validatePulledContent('hello​world', 'a.md');
    assert.match(pullWarnMessage(r), /不可視文字/);
  });

  it('returns empty warn message when nothing to warn', () => {
    const r = validatePulledContent('clean', 'a.md');
    assert.equal(pullWarnMessage(r), '');
  });
});

describe('toSecurityRecord', () => {
  it('produces a compact persistable record with denyReason for deny', () => {
    const r = validatePulledContent('\x00\x01\x02\x03'.repeat(20), 'a.md');
    const rec = toSecurityRecord(r);
    assert.equal(rec.decision, 'deny');
    assert.equal(rec.isBinary, true);
    assert.ok(typeof rec.denyReason === 'string' && rec.denyReason.length > 0);
    // denyFindings 等の大きな配列は含めない（compact）
    assert.equal('denyFindings' in rec, false);
  });

  it('leaves denyReason null for allow/warn', () => {
    const rec = toSecurityRecord(validatePulledContent('clean text', 'a.md'));
    assert.equal(rec.decision, 'allow');
    assert.equal(rec.denyReason, null);
  });
});

describe('isQuarantined', () => {
  it('returns true for a deny file', () => {
    const file = { security: toSecurityRecord(validatePulledContent('\x00\x01\x02\x03'.repeat(20), 'a.md')) };
    assert.equal(file.security.decision, 'deny');
    assert.equal(isQuarantined(file), true);
  });

  it('returns false for warn and allow files', () => {
    const warn = { security: toSecurityRecord(validatePulledContent('hello​world', 'a.md')) };
    const allow = { security: toSecurityRecord(validatePulledContent('clean text', 'a.md')) };
    assert.equal(warn.security.decision, 'warn');
    assert.equal(isQuarantined(warn), false);
    assert.equal(isQuarantined(allow), false);
  });

  it('returns false for files without a security record or null input', () => {
    assert.equal(isQuarantined({ id: 'a' }), false);
    assert.equal(isQuarantined(null), false);
    assert.equal(isQuarantined(undefined), false);
  });
});

describe('deriveEditedSecurity', () => {
  const warnRange = { from: 0, to: 1, severity: SEVERITY.WARN, label: 'ZWSP' };
  const denyRange = { from: 0, to: 1, severity: SEVERITY.DENY, label: 'RLO' };
  const baseSecurity = { decision: 'warn', isBinary: false, tooLarge: false, oversizeWarn: false, hasDeny: false, denyReason: null };

  it('returns null when originalSecurity is null', () => {
    assert.equal(deriveEditedSecurity([], null, 100), null);
  });

  it('returns null when originalSecurity is undefined', () => {
    assert.equal(deriveEditedSecurity([], undefined, 100), null);
  });

  it('returns originalSecurity unchanged when isBinary is true', () => {
    const binary = { ...baseSecurity, isBinary: true, decision: 'deny' };
    assert.strictEqual(deriveEditedSecurity([warnRange], binary, 100), binary);
  });

  it('warn findings → decision warn, hasDeny false', () => {
    const r = deriveEditedSecurity([warnRange], baseSecurity, 100);
    assert.equal(r.decision, 'warn');
    assert.equal(r.hasDeny, false);
    assert.equal(r.isBinary, false);
    assert.equal(r.denyReason, null);
  });

  it('returns same object reference when security state is unchanged', () => {
    // baseSecurity: decision:'warn', hasDeny:false → warnRange のみ → 同じ値 → 参照等価で返す
    assert.strictEqual(deriveEditedSecurity([warnRange], baseSecurity, 100), baseSecurity);
  });

  it('deny findings → decision warn (not deny), hasDeny true', () => {
    const r = deriveEditedSecurity([denyRange], baseSecurity, 100);
    assert.equal(r.decision, 'warn');
    assert.equal(r.hasDeny, true);
    assert.equal(r.denyReason, null);
  });

  it('warn + deny findings → decision warn, hasDeny true', () => {
    const r = deriveEditedSecurity([warnRange, denyRange], baseSecurity, 100);
    assert.equal(r.decision, 'warn');
    assert.equal(r.hasDeny, true);
  });

  it('no findings → decision allow', () => {
    const r = deriveEditedSecurity([], baseSecurity, 100);
    assert.equal(r.decision, 'allow');
    assert.equal(r.hasDeny, false);
    assert.equal(r.tooLarge, false);
    assert.equal(r.oversizeWarn, false);
  });

  it('contentLength > FILE_CONTENT_MAX → tooLarge true, decision warn', () => {
    const r = deriveEditedSecurity([], baseSecurity, FILE_CONTENT_MAX + 1);
    assert.equal(r.tooLarge, true);
    assert.equal(r.decision, 'warn');
    assert.equal(r.oversizeWarn, false);
  });

  it('contentLength > OVERSIZE_WARN_CHARS (but ≤ FILE_CONTENT_MAX) → oversizeWarn true, tooLarge false', () => {
    const r = deriveEditedSecurity([], baseSecurity, OVERSIZE_WARN_CHARS + 1);
    assert.equal(r.oversizeWarn, true);
    assert.equal(r.tooLarge, false);
    assert.equal(r.decision, 'allow');
  });

  it('denyReason is always null', () => {
    assert.equal(deriveEditedSecurity([denyRange], baseSecurity, 100).denyReason, null);
    assert.equal(deriveEditedSecurity([], baseSecurity, FILE_CONTENT_MAX + 1).denyReason, null);
  });

  it('works when called with originalSecurity from an allow file', () => {
    const allowSecurity = { decision: 'allow', isBinary: false, tooLarge: false, oversizeWarn: false, hasDeny: false, denyReason: null };
    const r = deriveEditedSecurity([warnRange], allowSecurity, 100);
    assert.equal(r.decision, 'warn');
  });
});
