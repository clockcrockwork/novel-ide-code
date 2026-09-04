import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFileName, isValidFileName } from '../../src/lib/security/validateSafeFileName.js';

describe('sanitizeFileName', () => {
  it('removes Bidi RLO (U+202E)', () => {
    const result = sanitizeFileName('file‮name.md');
    assert.equal(result, 'filename.md');
  });

  it('removes Null byte', () => {
    const result = sanitizeFileName('file\x00name.md');
    assert.equal(result, 'filename.md');
  });

  it('removes Zero Width Space (U+200B)', () => {
    const result = sanitizeFileName('file​name.md');
    assert.equal(result, 'filename.md');
  });

  it('removes ZWJ unconditionally (even in emoji context)', () => {
    // ZWJ between emoji — in file names we strip it
    const withZwj = '\u{1F468}‍\u{1F469}.md';
    const result = sanitizeFileName(withZwj);
    assert.ok(!result.includes('‍'), 'ZWJ should be removed');
    // Emoji themselves should remain
    assert.ok(result.includes('👨'), 'man emoji should remain');
    assert.ok(result.includes('👩'), 'woman emoji should remain');
  });

  it('removes Variation Selector from file name', () => {
    const withVS = 'A️.md';
    const result = sanitizeFileName(withVS);
    assert.ok(!result.includes('️'));
  });

  it('keeps plain emoji in file name', () => {
    const result = sanitizeFileName('日記🌸.md');
    assert.equal(result, '日記🌸.md');
  });

  it('converts NBSP to regular space', () => {
    const result = sanitizeFileName('my file.md');
    assert.equal(result, 'my file.md');
  });

  it('trims and enforces maxLen', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeFileName(long, 100);
    assert.equal(result.length, 100);
  });

  it('trims trailing space when maxLen cuts at space boundary', () => {
    // "abc def" → 7 code points; maxLen=4 raw slice = "abc " → trimEnd → "abc"
    assert.equal(sanitizeFileName('abc def', 4), 'abc');
  });

  it('NFC normalizes NFD input', () => {
    // é in NFD = U+0065 + U+0301; in NFC = U+00E9
    const nfd = 'é.md';
    const result = sanitizeFileName(nfd);
    // Should produce NFC é
    assert.equal(result, 'é.md');
  });

  it('removes control characters', () => {
    const result = sanitizeFileName('filename.md');
    assert.equal(result, 'filename.md');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(sanitizeFileName(null), '');
    assert.equal(sanitizeFileName(undefined), '');
    assert.equal(sanitizeFileName(42), '');
  });

  it('preserves Japanese filename unchanged', () => {
    const name = '第一章　始まり.md';
    assert.equal(sanitizeFileName(name), name);
  });

  it('collapses consecutive spaces', () => {
    // Two NBSP between words → two plain spaces → collapsed to one
    const name = 'hello  world.md';
    assert.equal(sanitizeFileName(name), 'hello world.md');
  });

  it('removes forward slash (path separator)', () => {
    assert.equal(sanitizeFileName('foo/bar.md'), 'foobar.md');
  });

  it('removes backslash (Windows path separator)', () => {
    assert.equal(sanitizeFileName('foo\\bar.md'), 'foobar.md');
  });

  it('removes tab character', () => {
    assert.equal(sanitizeFileName('foo\tbar.md'), 'foobar.md');
  });

  it('removes LF character', () => {
    assert.equal(sanitizeFileName('foo\nbar.md'), 'foobar.md');
  });

  it('removes CR character', () => {
    assert.equal(sanitizeFileName('foo\rbar.md'), 'foobar.md');
  });

  it('handles extreme-length input without hanging (DoS guard)', () => {
    const huge = 'a'.repeat(1_000_000);
    const start = Date.now();
    const result = sanitizeFileName(huge, 100);
    assert.ok(Date.now() - start < 500, 'should complete in under 500ms');
    assert.equal(result.length, 100);
  });

  it('slices by code point, not code unit (emoji at boundary)', () => {
    // "ab" + 🌸 (2 code units) = 4 code units, 3 code points
    // with maxLen=3, should keep all 3 code points including the emoji
    const name = 'ab🌸';
    assert.equal(sanitizeFileName(name, 3), 'ab🌸');
    // with maxLen=2, should drop emoji but not split it
    assert.equal(sanitizeFileName(name, 2), 'ab');
  });

  it('removes ZWNJ (U+200C)', () => {
    assert.equal(sanitizeFileName('file‌name.md'), 'filename.md');
  });

  it('removes Soft Hyphen (U+00AD, WARN char)', () => {
    assert.equal(sanitizeFileName('file­name.md'), 'filename.md');
  });

  it('removes Delete (U+007F, WARN char)', () => {
    assert.equal(sanitizeFileName('filename.md'), 'filename.md');
  });

  it('removes BOM (U+FEFF, WARN char)', () => {
    assert.equal(sanitizeFileName('﻿file.md'), 'file.md');
  });

  it('trims leading and trailing spaces', () => {
    assert.equal(sanitizeFileName('  file.md  '), 'file.md');
  });

  it('strips orphaned combining mark that survives NFC', () => {
    // NFC('à̀') = 'à̀' — second mark is orphaned, stripped by isCombiningMark
    assert.equal(sanitizeFileName('à̀.md'), 'à.md');
  });

  it('returns empty string for "." (reserved path component)', () => {
    assert.equal(sanitizeFileName('.'), '');
  });

  it('returns empty string for ".." (reserved path component)', () => {
    assert.equal(sanitizeFileName('..'), '');
  });
});

describe('isValidFileName', () => {
  it('returns false for file name with Bidi char', () => {
    assert.equal(isValidFileName('file‮name.md'), false);
  });

  it('returns false for file name with ZWS', () => {
    assert.equal(isValidFileName('file​name.md'), false);
  });

  it('returns true for clean filename', () => {
    assert.equal(isValidFileName('第一章.md'), true);
  });

  it('returns false for empty string', () => {
    assert.equal(isValidFileName(''), false);
  });

  it('returns false for non-string', () => {
    assert.equal(isValidFileName(null), false);
  });

  it('returns true for 100+ clean chars (length limit is caller responsibility)', () => {
    const long = 'あ'.repeat(120) + '.md';
    assert.equal(isValidFileName(long), true);
  });

  it('returns false for file name with leading/trailing spaces', () => {
    // sanitizeFileName would trim these, so the name is not valid as-is
    assert.equal(isValidFileName(' file.md '), false);
    assert.equal(isValidFileName(' file.md'), false);
  });

  it('returns true for 256 clean ASCII chars (isValidFileName does not enforce length limits)', () => {
    // length limits are the caller's responsibility; clean names pass regardless of length
    assert.equal(isValidFileName('a'.repeat(256)), true);
  });

  it('returns true for 128-emoji filename (128 code points, 256 code units)', () => {
    // 🌸 is 2 code units but 1 code point; 128 emoji = 256 code units but only 128 code points
    const emojiName = '🌸'.repeat(128) + '.md';
    assert.equal(isValidFileName(emojiName), true);
  });

  it('returns false for file name longer than 1020 code units (DoS guard)', () => {
    assert.equal(isValidFileName('a'.repeat(1021)), false);
  });

  it('returns false for file name with path separator /', () => {
    assert.equal(isValidFileName('foo/bar.md'), false);
  });

  it('returns false for file name with path separator \\', () => {
    assert.equal(isValidFileName('foo\\bar.md'), false);
  });

  it('returns false for file name with LF', () => {
    assert.equal(isValidFileName('foo\nbar.md'), false);
  });

  it('returns false for file name with tab', () => {
    assert.equal(isValidFileName('foo\tbar.md'), false);
  });

  it('returns false for file name with CR', () => {
    assert.equal(isValidFileName('foo\rbar.md'), false);
  });

  it('returns false for file name with Soft Hyphen (WARN char)', () => {
    assert.equal(isValidFileName('file­name.md'), false);
  });

  it('returns false for file name with NBSP (converted to space, != original)', () => {
    assert.equal(isValidFileName('file name.md'), false);
  });

  it('returns false for "." (reserved path component)', () => {
    assert.equal(isValidFileName('.'), false);
  });

  it('returns false for ".." (reserved path component)', () => {
    assert.equal(isValidFileName('..'), false);
  });
});
