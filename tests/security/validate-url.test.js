import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUrl,
  sanitizeUrlForExport,
  safeExternalHref,
} from '../../src/lib/security/validateUrl.js';

describe('validateUrl', () => {
  describe('許可 — https / http', () => {
    it('https URL', () => assert.equal(validateUrl('https://example.com'), null));
    it('http URL', () => assert.equal(validateUrl('http://example.com'), null));
    it('大文字 HTTPS', () => assert.equal(validateUrl('HTTPS://example.com'), null));
    it('パス・クエリ付き', () => assert.equal(validateUrl('https://example.com/path?q=1'), null));
    it('先頭スペース付き', () => assert.equal(validateUrl('  https://example.com'), null));
    it('末尾スペース付き', () => assert.equal(validateUrl('https://example.com  '), null));
  });

  describe('拒否 — 危険なスキーム', () => {
    it('javascript:', () => assert.notEqual(validateUrl('javascript:alert(1)'), null));
    it('data:', () => assert.notEqual(validateUrl('data:text/html,<h1>x</h1>'), null));
    it('file:', () => assert.notEqual(validateUrl('file:///etc/passwd'), null));
    it('blob:', () => assert.notEqual(validateUrl('blob:https://example.com/abc'), null));
    it('vbscript:', () => assert.notEqual(validateUrl('vbscript:msgbox(1)'), null));
    it('スキームなし', () => assert.notEqual(validateUrl('example.com'), null));
    it('// から始まる相対 URL', () => assert.notEqual(validateUrl('//example.com'), null));
    it('ホストなし https://', () => assert.notEqual(validateUrl('https://'), null));
    it('Bidi RLO を含む URL', () =>
      assert.notEqual(validateUrl('https://example.com/path‮dangerous'), null));
    it('LF を含む URL', () => assert.notEqual(validateUrl('https://example.com\npath'), null));
    it('Tab を含む URL', () => assert.notEqual(validateUrl('https://example.com\tfoo'), null));
    it('ZWS を含む URL', () => assert.notEqual(validateUrl('https://example.com/​foo'), null));
    it('バックスラッシュを含む URL', () =>
      assert.notEqual(validateUrl('https://example.com\\foo'), null));
  });

  describe('拒否 — 型・長さ', () => {
    it('空文字', () => assert.notEqual(validateUrl(''), null));
    it('スペースのみ', () => assert.notEqual(validateUrl('   '), null));
    it('null', () => assert.notEqual(validateUrl(null), null));
    it('undefined', () => assert.notEqual(validateUrl(undefined), null));
    it('数値', () => assert.notEqual(validateUrl(42), null));
    it('2001文字以上', () =>
      assert.notEqual(validateUrl('https://example.com/' + 'a'.repeat(2000)), null));
  });

  describe('境界値', () => {
    it('2000文字の URL は許可', () => {
      const url = 'https://example.com/' + 'a'.repeat(1980); // 20 + 1980 = 2000
      assert.equal(validateUrl(url), null);
    });
  });
});

describe('sanitizeUrlForExport', () => {
  it('https URL → 正規化して返す', () =>
    assert.equal(sanitizeUrlForExport('https://example.com'), 'https://example.com/'));
  it('先頭/末尾スペースは trim して正規化', () =>
    assert.equal(sanitizeUrlForExport('  https://example.com  '), 'https://example.com/'));
  it('javascript: → undefined', () =>
    assert.equal(sanitizeUrlForExport('javascript:alert(1)'), undefined));
  it('空文字 → undefined', () => assert.equal(sanitizeUrlForExport(''), undefined));
  it('非文字列 → undefined', () => assert.equal(sanitizeUrlForExport(null), undefined));
  it('バックスラッシュを含む URL → undefined', () =>
    assert.equal(sanitizeUrlForExport('https://example.com\\foo'), undefined));
  it('2001文字以上は undefined', () => {
    const url = 'https://x.com/' + 'a'.repeat(2000);
    assert.equal(sanitizeUrlForExport(url), undefined);
  });
});

describe('safeExternalHref', () => {
  it('https URL → 元 URL を trim して返す（正規化しない）', () =>
    assert.equal(safeExternalHref('https://github.com/o/r/pull/5'), 'https://github.com/o/r/pull/5'));
  it('先頭/末尾スペースは trim', () =>
    assert.equal(safeExternalHref('  https://github.com/x  '), 'https://github.com/x'));
  it('クエリ付き avatar URL を維持', () =>
    assert.equal(
      safeExternalHref('https://avatars.githubusercontent.com/u/1?v=4'),
      'https://avatars.githubusercontent.com/u/1?v=4',
    ));
  it('javascript: → undefined', () =>
    assert.equal(safeExternalHref('javascript:alert(1)'), undefined));
  it('data: → undefined', () =>
    assert.equal(safeExternalHref('data:text/html,<h1>x</h1>'), undefined));
  it('空文字 → undefined', () => assert.equal(safeExternalHref(''), undefined));
  it('非文字列 → undefined', () => assert.equal(safeExternalHref(null), undefined));
  it('undefined → undefined', () => assert.equal(safeExternalHref(undefined), undefined));
});
