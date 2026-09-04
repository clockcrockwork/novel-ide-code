import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../src/lib/markdown.js';

test('parseMarkdown renders heading and bold', () => {
  const html = parseMarkdown('# 見出し\n**強調**', false);
  assert.equal(html, '<h1>見出し</h1><p><strong>強調</strong></p>');
});

test('parseMarkdown preview mode removes line comments', () => {
  const html = parseMarkdown('// コメント\n本文', true);
  assert.equal(html, '<p>本文</p>');
});

test('parseMarkdown supports ruby syntax', () => {
  const html = parseMarkdown('{漢字|かんじ}', false);
  assert.equal(html, '<p><ruby>漢字<rt>かんじ</rt></ruby></p>');
});

test('parseMarkdown escapes HTML tags', () => {
  const html = parseMarkdown('<script>alert(1)</script>', false);
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('parseMarkdown: ルビのbase部分のHTMLタグをエスケープする', () => {
  const html = parseMarkdown('{<img src=x onerror=alert(1)>|ふりがな}', false);
  assert.equal(html, '<p><ruby>&lt;img src=x onerror=alert(1)&gt;<rt>ふりがな</rt></ruby></p>');
});

test('parseMarkdown: ルビのふりがな部分のHTMLタグをエスケープする', () => {
  const html = parseMarkdown('{漢字|<script>alert(1)</script>}', false);
  assert.equal(html, '<p><ruby>漢字<rt>&lt;script&gt;alert(1)&lt;/script&gt;</rt></ruby></p>');
});

test('parseMarkdown: ボールド構文内のHTMLタグをエスケープする', () => {
  const html = parseMarkdown('**<script>alert(1)</script>**', false);
  assert.equal(html, '<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>');
});

test('parseMarkdown: ボールド内にルビをネストできる', () => {
  const html = parseMarkdown('**{漢字|かんじ}**', false);
  assert.equal(html, '<p><strong><ruby>漢字<rt>かんじ</rt></ruby></strong></p>');
});

test('parseMarkdown: ボールド内ルビでもHTMLをエスケープする', () => {
  const html = parseMarkdown('**{<img>|ruby}**', false);
  assert.equal(html, '<p><strong><ruby>&lt;img&gt;<rt>ruby</rt></ruby></strong></p>');
});

test('parseMarkdown: 見出し内のHTMLタグをエスケープする', () => {
  const html = parseMarkdown('# <script>alert(1)</script>', false);
  assert.equal(html, '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
});

test('parseMarkdown: プレビューモードでもルビ内のHTMLをエスケープする', () => {
  const html = parseMarkdown('{<img src=x onerror=alert(1)>|ふりがな}', true);
  assert.equal(html, '<p><ruby>&lt;img src=x onerror=alert(1)&gt;<rt>ふりがな</rt></ruby></p>');
});

test('parseMarkdown: ルビのbaseのアンパサンドをエスケープする', () => {
  const html = parseMarkdown('{a&b|かんじ}', false);
  assert.equal(html, '<p><ruby>a&amp;b<rt>かんじ</rt></ruby></p>');
});

test('parseMarkdown: ルビのbase内のボールドをネストできる', () => {
  const html = parseMarkdown('{**重要**|じゅうよう}', false);
  assert.equal(html, '<p><ruby><strong>重要</strong><rt>じゅうよう</rt></ruby></p>');
});

test('parseMarkdown: ルビのbase内ネストでもHTMLをエスケープする', () => {
  const html = parseMarkdown('{**<script>**|ruby}', false);
  assert.equal(html, '<p><ruby><strong>&lt;script&gt;</strong><rt>ruby</rt></ruby></p>');
});

test('parseMarkdown: ルビのtext内のボールドをネストできる', () => {
  const html = parseMarkdown('{漢字|**bold**}', false);
  assert.equal(html, '<p><ruby>漢字<rt><strong>bold</strong></rt></ruby></p>');
});

test('parseMarkdown: 非プレビューモードでメモをspanに変換する', () => {
  const html = parseMarkdown('/* comment */', false);
  assert.equal(html, '<p><span class="hl-memo">/* comment */</span></p>');
});

test('parseMarkdown: プレビューモードでブロックコメントを除去する', () => {
  const html = parseMarkdown('/* comment */', true);
  assert.equal(html, '');
});

test('parseMarkdown: ダブルクォートをエスケープする', () => {
  const html = parseMarkdown('say "hello"', false);
  assert.equal(html, '<p>say &quot;hello&quot;</p>');
});

test('parseMarkdown: シングルクォートをエスケープする', () => {
  const html = parseMarkdown("it's fine", false);
  assert.equal(html, '<p>it&#39;s fine</p>');
});
