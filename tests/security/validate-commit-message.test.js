import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommitMessage } from '../../src/lib/security/validateCommitMessage.js';

const ok = (v) =>
  assert.equal(validateCommitMessage(v), null, `should allow: ${JSON.stringify(v)}`);
const ng = (v) =>
  assert.notEqual(validateCommitMessage(v), null, `should deny: ${JSON.stringify(v)}`);

describe('validateCommitMessage', () => {
  describe('許可', () => {
    it('通常の日本語テンプレート', () => ok('原稿を更新'));
    it('変数プレースホルダー付き', () => ok('{filename} を更新 ({date})'));
    it('英数字', () => ok('Update {filename}'));
    it('空文字', () => ok(''));
    it('500文字', () => ok('a'.repeat(500)));
    it('絵文字（安全）', () => ok('✏️ 原稿を更新'));
  });

  describe('拒否', () => {
    it('非文字列', () => ng(42));
    it('null', () => ng(null));
    it('501文字以上', () => ng('a'.repeat(501)));
    it('null バイト', () => ng('update\x00file'));
    it('Bidi RLO 制御文字', () => ng('update‮file'));
    it('LRO 制御文字', () => ng('‭update'));
    it('RLI 制御文字', () => ng('update⁧file'));
    it('改行 LF', () => ng('update\nfile'));
    it('改行 CR', () => ng('update\rfile'));
    it('ESC (C0制御文字)', () => ng('update\x1bfile'));
    it('BEL (C0制御文字)', () => ng('update\x07file'));
    it('C1制御文字 U+0080', () => ng('update\x80file'));
    it('DEL (U+007F)', () => ng('update\x7ffile'));
  });
});
