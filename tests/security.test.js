import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../src/lib/markdown.js';

test('parseMarkdown: SVG onload 属性をエスケープする', () => {
  const html = parseMarkdown('<svg onload=alert(1)>', false);
  assert.equal(html, '<p>&lt;svg onload=alert(1)&gt;</p>');
});

test('parseMarkdown: iframe タグをエスケープする', () => {
  const html = parseMarkdown('<iframe src="https://evil.example.com">', false);
  assert.equal(html, '<p>&lt;iframe src=&quot;https://evil.example.com&quot;&gt;</p>');
});

test('parseMarkdown: style 属性内の javascript: URI をエスケープする', () => {
  const html = parseMarkdown('<div style="background:url(javascript:alert(1))">', false);
  assert.equal(html, '<p>&lt;div style=&quot;background:url(javascript:alert(1))&quot;&gt;</p>');
});

test('parseMarkdown: data URI を含む img タグをエスケープする', () => {
  const html = parseMarkdown('<img src="data:text/html,<script>alert(1)</script>">', false);
  assert.equal(
    html,
    '<p>&lt;img src=&quot;data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;</p>',
  );
});

test('parseMarkdown: 裸の javascript: スキーム文字列はプレーンテキストとして出力される', () => {
  const html = parseMarkdown('javascript:alert(1)', false);
  assert.equal(html, '<p>javascript:alert(1)</p>');
  assert.ok(!html.includes('<script'), 'スクリプトタグが生成されない');
});

test('parseMarkdown: 既存 HTML エンティティは二重エスケープされる（意図的な挙動）', () => {
  // &lt;script&gt; → &amp;lt;script&amp;gt; (正しい挙動: & → &amp;)
  const html = parseMarkdown('&lt;script&gt;', false);
  assert.equal(html, '<p>&amp;lt;script&amp;gt;</p>');
});

test('parseMarkdown: プレビューモードでも SVG onload をエスケープする', () => {
  const html = parseMarkdown('<svg onload=alert(1)>', true);
  assert.equal(html, '<p>&lt;svg onload=alert(1)&gt;</p>');
});

test('parseMarkdown: プレビューモードでも iframe をエスケープする', () => {
  const html = parseMarkdown('<iframe src="https://evil.example.com">', true);
  assert.equal(html, '<p>&lt;iframe src=&quot;https://evil.example.com&quot;&gt;</p>');
});

test('parseMarkdown: ルビのふりがな部分の javascript: スキームはそのままテキスト出力される', () => {
  const html = parseMarkdown('{text|javascript:alert(1)}', false);
  // javascript: は HTML タグではないのでエスケープ不要、rt 要素のテキストとして安全に出力される
  assert.equal(html, '<p><ruby>text<rt>javascript:alert(1)</rt></ruby></p>');
  assert.ok(!html.includes('onerror'), 'イベントハンドラが含まれない');
});

test('parseMarkdown: SVG 内の script タグをエスケープする', () => {
  const html = parseMarkdown('<svg><script>alert(1)</script></svg>', false);
  assert.ok(!html.includes('<script'), 'script タグが出力されない');
  assert.ok(html.includes('&lt;svg&gt;'), 'SVG タグがエスケープされている');
});

test('parseMarkdown: HTML コメント区切りをエスケープする', () => {
  const html = parseMarkdown('<!-- <script>alert(1)</script> -->', false);
  assert.ok(!html.includes('<script'), 'script タグが出力されない');
  assert.ok(!html.includes('<!--'), 'コメント開始タグが出力されない');
});

test('parseMarkdown: Markdown リンク記法内の javascript: はリンクとして生成されない', () => {
  // markdown.js はリンク構文を実装していないため、[text](url) はテキストとして出力される
  const html = parseMarkdown('[click](javascript:alert(1))', false);
  assert.ok(!html.includes('<a '), 'a タグが生成されない');
  assert.ok(!html.includes('href'), 'href 属性が生成されない');
});
