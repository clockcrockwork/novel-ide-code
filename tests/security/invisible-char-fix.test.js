import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFindings, fixInvisibleChars } from '../../src/lib/security/invisibleCharFix.js';

describe('summarizeFindings', () => {
  it('deny / warn を label × 件数で集計する', () => {
    // RLO(deny) ×1, ZWSP(warn) ×2
    const s = summarizeFindings('a‮b​c​d');
    assert.equal(s.denyTotal, 1);
    assert.equal(s.warnTotal, 2);
    assert.ok(s.deny.some((x) => x.label.includes('Bidi') && x.count === 1));
    assert.ok(s.warn.some((x) => x.label === 'Zero Width Space' && x.count === 2));
  });

  it('clean text は 0 件', () => {
    const s = summarizeFindings('普通の文章です。');
    assert.equal(s.denyTotal, 0);
    assert.equal(s.warnTotal, 0);
    assert.deepEqual(s.deny, []);
    assert.deepEqual(s.warn, []);
  });
});

describe('fixInvisibleChars', () => {
  it('deny（Bidi）を除去する', () => {
    const { text, fixed } = fixInvisibleChars('a‮b', ['deny']);
    assert.equal(text, 'ab');
    assert.equal(fixed, 1);
  });

  it('ZWSP（warn）を除去する', () => {
    const { text, fixed } = fixInvisibleChars('a​b', ['warn']);
    assert.equal(text, 'ab');
    assert.equal(fixed, 1);
  });

  it('NBSP は半角スペースへ正規化する（除去で語が連結しない）', () => {
    const { text, fixed } = fixInvisibleChars('a b', ['warn']);
    assert.equal(text, 'a b');
    assert.equal(fixed, 1);
  });

  it('対象 severity 以外は触らない（warn 指定で Bidi は残る）', () => {
    const { text, fixed } = fixInvisibleChars('a‮b', ['warn']);
    assert.equal(text, 'a‮b');
    assert.equal(fixed, 0);
  });

  it('対象なしは原文をそのまま返す', () => {
    const { text, fixed } = fixInvisibleChars('clean', ['deny', 'warn']);
    assert.equal(text, 'clean');
    assert.equal(fixed, 0);
  });

  it('combining run（codePoint < 0 の集約 finding）は auto-fix 対象外', () => {
    const base = 'e' + '́'.repeat(6); // 6 個 → combining run finding
    const { text, fixed } = fixInvisibleChars(base, ['warn']);
    assert.equal(fixed, 0);
    assert.equal(text, base);
  });

  it('surrogate pair を含むテキストで index がずれない', () => {
    const { text, fixed } = fixInvisibleChars('😀​😀', ['warn']);
    assert.equal(text, '😀😀');
    assert.equal(fixed, 1);
  });

  it('非文字列は空文字を返す', () => {
    const { text, fixed } = fixInvisibleChars(null, ['deny']);
    assert.equal(text, '');
    assert.equal(fixed, 0);
  });
});
