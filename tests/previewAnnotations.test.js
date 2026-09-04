import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAnnotationsToHTML,
  applyAnnotationsToBlocks,
  splitIntoBlocks,
  cachedParseMarkdown,
  _clearParseCache,
  _parseCache,
} from '../src/lib/previewAnnotations.js';

// ── splitIntoBlocks ───────────────────────────────────────────────────────────

test('splitIntoBlocks: 空文字は空配列を返す', () => {
  assert.deepEqual(splitIntoBlocks(''), []);
  assert.deepEqual(splitIntoBlocks(null), []);
  assert.deepEqual(splitIntoBlocks(undefined), []);
});

test('splitIntoBlocks: 単一段落を1要素の配列にする', () => {
  const html = '<p>本文テスト</p>';
  assert.deepEqual(splitIntoBlocks(html), ['<p>本文テスト</p>']);
});

test('splitIntoBlocks: 複数段落を分割する', () => {
  const html = '<p>一段落目</p><p>二段落目</p><p>三段落目</p>';
  assert.deepEqual(splitIntoBlocks(html), [
    '<p>一段落目</p>',
    '<p>二段落目</p>',
    '<p>三段落目</p>',
  ]);
});

test('splitIntoBlocks: 見出しと段落を分割する', () => {
  const html = '<h1>タイトル</h1><p>本文</p><h2>小見出し</h2>';
  assert.deepEqual(splitIntoBlocks(html), [
    '<h1>タイトル</h1>',
    '<p>本文</p>',
    '<h2>小見出し</h2>',
  ]);
});

test('splitIntoBlocks: hrを独立したブロックとして分割する', () => {
  const html = '<p>前</p><hr/><p>後</p>';
  assert.deepEqual(splitIntoBlocks(html), ['<p>前</p>', '<hr/>', '<p>後</p>']);
});

test('splitIntoBlocks: インライン要素を含む段落はそのまま保持する', () => {
  const html = '<p><strong>太字</strong>と<ruby>漢字<rt>かんじ</rt></ruby></p>';
  assert.deepEqual(splitIntoBlocks(html), [
    '<p><strong>太字</strong>と<ruby>漢字<rt>かんじ</rt></ruby></p>',
  ]);
});

test('splitIntoBlocks: 認識できないHTMLは配列に丸ごと返す', () => {
  const html = 'プレーンテキスト';
  assert.deepEqual(splitIntoBlocks(html), ['プレーンテキスト']);
});

test('splitIntoBlocks: 一致しないテキストと混在する場合は丸ごと返してデータロスしない', () => {
  // 正規表現にマッチしないテキストが先頭にある場合、消失しないことを確認
  const html = 'プレーンテキスト<p>テスト</p>';
  const result = splitIntoBlocks(html);
  assert.ok(
    result.includes(html) || result.join('') === html,
    `content must not be lost: ${JSON.stringify(result)}`,
  );
});

// ── applyAnnotationsToHTML ────────────────────────────────────────────────────

const YELLOW = 'oklch(.86 .14 80/.52)';

test('applyAnnotationsToHTML: アノテーションなしはそのまま返す', () => {
  const html = '<p>本文テスト</p>';
  assert.equal(applyAnnotationsToHTML(html, []), html);
  assert.equal(applyAnnotationsToHTML(html, null), html);
});

test('applyAnnotationsToHTML: markerアノテーションをmarkタグに変換する', () => {
  const html = '<p>テスト本文</p>';
  const annos = [
    {
      id: 'anno-1',
      type: 'marker',
      selectedText: 'テスト',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  assert.ok(result.includes('<mark class="a-mark"'), `mark tag not found: ${result}`);
  assert.ok(result.includes('data-anno-id="anno-1"'), `data-anno-id not found: ${result}`);
  assert.ok(result.includes('テスト'), `text not found: ${result}`);
});

test('applyAnnotationsToHTML: memoアノテーションをspanタグに変換する', () => {
  const html = '<p>テスト本文</p>';
  const annos = [
    {
      id: 'anno-2',
      type: 'memo',
      selectedText: 'テスト',
      note: 'メモ内容',
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  assert.ok(result.includes('<span class="a-memo"'), `span tag not found: ${result}`);
  assert.ok(result.includes('data-note="メモ内容"'), `note not found: ${result}`);
});

test('applyAnnotationsToHTML: occurrenceIdx=1 は2番目の出現にのみ適用する', () => {
  const html = '<p>テスト と テスト</p>';
  const annos = [
    {
      id: 'anno-3',
      type: 'marker',
      selectedText: 'テスト',
      color: YELLOW,
      occurrenceIdx: 1,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  const markCount = (result.match(/<mark/g) || []).length;
  assert.equal(markCount, 1, `expected 1 mark, got: ${result}`);
  assert.ok(result.startsWith('<p>テスト '), 'first occurrence should be plain text');
});

test('applyAnnotationsToHTML: HTMLエスケープ済みテキストでXSSを防ぐ', () => {
  const html = '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>';
  const annos = [
    {
      id: 'xss-test',
      type: 'marker',
      selectedText: '<script>alert(1)</script>',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  assert.ok(!result.includes('<script>'), `raw script tag must not appear: ${result}`);
});

test('applyAnnotationsToHTML: noteのHTMLエスケープ — <img> タグが挿入されない', () => {
  const html = '<p>テスト</p>';
  const annos = [
    {
      id: 'note-xss',
      type: 'memo',
      selectedText: 'テスト',
      note: '"><img onerror=alert(1)',
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  // escapeAttr により < が &lt; に変換されるため生の <img タグは出現しない
  assert.ok(!result.includes('<img'), `raw <img> tag must not appear in HTML: ${result}`);
  assert.ok(result.includes('&lt;img'), `< must be escaped as &lt;: ${result}`);
});

test('applyAnnotationsToHTML: selectedText が HTML タグ名と一致しても HTML 構造を壊さない', () => {
  // "mark" は <mark class="a-mark"> タグ名・属性値に含まれるが、テキストノードのみに適用されるべき
  const html = '<p>mark and text</p>';
  const annos = [
    {
      id: 'tag-name-test',
      type: 'marker',
      selectedText: 'mark',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  // <mark> タグが1つだけ挿入される
  const markOpenCount = (result.match(/<mark\b/g) || []).length;
  assert.equal(markOpenCount, 1, `exactly 1 <mark> should be inserted: ${result}`);
  // <p> タグが壊れていない
  assert.ok(result.startsWith('<p>'), `<p> must not be broken: ${result}`);
  // テキスト "mark" がハイライトされている
  assert.ok(result.includes('>mark<'), `text "mark" must be wrapped: ${result}`);
});

test('applyAnnotationsToHTML: selectedText が HTML エンティティの一部（"lt" 等）と一致してもエンティティを破壊しない', () => {
  // &lt; は "lt" を含むが、エンティティはスキップしてテキストノードの "lt" のみをハイライトする
  const html = '<p>&lt; and lt</p>';
  const annos = [
    {
      id: 'entity-test',
      type: 'marker',
      selectedText: 'lt',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  assert.ok(result.includes('&lt;'), `&lt; must not be broken: ${result}`);
  assert.ok(result.includes('>lt<'), `text "lt" must be wrapped: ${result}`);
});

test('applyAnnotationsToHTML: selectedText が HTML エンティティを含む場合（"<p>" 等）に正しくハイライトされる', () => {
  const html = '<p>&lt;p&gt; text</p>';
  const annos = [
    {
      id: 'tag-text-test',
      type: 'marker',
      selectedText: '<p>',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToHTML(html, annos);
  assert.ok(result.includes('<mark'), `should highlight "<p>": ${result}`);
});

test('applyAnnotationsToBlocks: HTML エンティティを含むブロックでの正確な出現カウントとローカル変換', () => {
  // block[0] に &lt;（エンティティ内の "lt" はカウント除外）、block[1] に "lt"（テキスト）
  // occurrenceIdx=0 は block[1] に適用されるべき
  const blocks = ['<p>&lt;</p>', '<p>lt</p>'];
  const annos = [
    {
      id: 'entity-block-test',
      type: 'marker',
      selectedText: 'lt',
      color: YELLOW,
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToBlocks(blocks, annos);
  assert.ok(!result[0].includes('<mark'), `block[0] must NOT have mark: ${result[0]}`);
  assert.ok(result[1].includes('<mark'), `block[1] should have mark: ${result[1]}`);
});

// ── cachedParseMarkdown ───────────────────────────────────────────────────────

test('cachedParseMarkdown: markdownを正しくHTMLに変換する', () => {
  _clearParseCache();
  const result = cachedParseMarkdown('# 見出し\n\n段落');
  assert.ok(result.includes('<h1>'), `h1 not found: ${result}`);
  assert.ok(result.includes('<p>'), `p not found: ${result}`);
});

test('cachedParseMarkdown: 同一contentはキャッシュから返す', () => {
  _clearParseCache();
  const content = 'キャッシュテスト\n\n本文';
  const first = cachedParseMarkdown(content);
  const second = cachedParseMarkdown(content);
  assert.equal(first, second, 'cached result must be identical string');
  assert.strictEqual(first, second, 'must be same reference from cache');
});

test('cachedParseMarkdown: コメントはプレビューで除去される', () => {
  _clearParseCache();
  const result = cachedParseMarkdown('本文\n\n/* コメント */');
  assert.ok(!result.includes('コメント'), `comment should be stripped in preview: ${result}`);
});

test('cachedParseMarkdown: コンテンツが変われば再パースする', () => {
  _clearParseCache();
  const a = cachedParseMarkdown('内容A');
  const b = cachedParseMarkdown('内容B');
  assert.notEqual(a, b);
});

test('cachedParseMarkdown: LRU — 再アクセスしたエントリは6件超でも保持される', () => {
  _clearParseCache();
  // 5件登録: [内容0, 内容1, 内容2, 内容3, 内容4]
  for (let i = 0; i < 5; i++) cachedParseMarkdown(`内容${i}`);
  // 最古の 内容0 に再アクセス → LRU 末尾へ移動: [内容1, 内容2, 内容3, 内容4, 内容0]
  const keptResult = cachedParseMarkdown('内容0');
  // 新規追加 → size=6>5 → 最古の 内容1 が削除: [内容2, 内容3, 内容4, 内容0, 内容X]
  cachedParseMarkdown('内容X');
  assert.ok(_parseCache.has('内容0'), 'LRU: 再アクセス済みエントリは削除されない');
  assert.ok(!_parseCache.has('内容1'), 'LRU: 最古の未アクセスエントリが削除される');
  const again = cachedParseMarkdown('内容0');
  assert.strictEqual(again, keptResult, 'LRU: 保持されたエントリの値が同一');
  _clearParseCache();
});

// ── applyAnnotationsToBlocks ──────────────────────────────────────────────────

test('applyAnnotationsToBlocks: アノテーションなしはそのまま返す', () => {
  const blocks = ['<p>一段落目</p>', '<p>二段落目</p>'];
  assert.deepEqual(applyAnnotationsToBlocks(blocks, []), blocks);
  assert.deepEqual(applyAnnotationsToBlocks(blocks, null), blocks);
});

test('applyAnnotationsToBlocks: occurrenceIdx=0 は1ブロック目のみにハイライト', () => {
  const blocks = ['<p>テスト</p>', '<p>テスト</p>'];
  const annos = [
    {
      id: 'a1',
      type: 'marker',
      selectedText: 'テスト',
      color: 'oklch(.86 .14 80/.52)',
      occurrenceIdx: 0,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToBlocks(blocks, annos);
  assert.ok(result[0].includes('<mark'), `block[0] should have mark: ${result[0]}`);
  assert.ok(!result[1].includes('<mark'), `block[1] must NOT have mark: ${result[1]}`);
});

test('applyAnnotationsToBlocks: occurrenceIdx=1 は2ブロック目にハイライト（グローバル2番目）', () => {
  const blocks = ['<p>テスト</p>', '<p>テスト</p>'];
  const annos = [
    {
      id: 'a2',
      type: 'marker',
      selectedText: 'テスト',
      color: 'oklch(.86 .14 80/.52)',
      occurrenceIdx: 1,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToBlocks(blocks, annos);
  assert.ok(!result[0].includes('<mark'), `block[0] must NOT have mark: ${result[0]}`);
  assert.ok(result[1].includes('<mark'), `block[1] should have mark: ${result[1]}`);
});

test('applyAnnotationsToBlocks: 各ブロック内の出現が複数ある場合のローカル変換', () => {
  // block[0]に2回、block[1]に1回 → occurrenceIdx=2はblock[1]の0番目
  const blocks = ['<p>テスト と テスト</p>', '<p>テスト</p>'];
  const annos = [
    {
      id: 'a3',
      type: 'marker',
      selectedText: 'テスト',
      color: 'oklch(.86 .14 80/.52)',
      occurrenceIdx: 2,
      createdAt: 0,
    },
  ];
  const result = applyAnnotationsToBlocks(blocks, annos);
  const marksInBlock0 = (result[0].match(/<mark/g) || []).length;
  const marksInBlock1 = (result[1].match(/<mark/g) || []).length;
  assert.equal(marksInBlock0, 0, `block[0] must have 0 marks: ${result[0]}`);
  assert.equal(marksInBlock1, 1, `block[1] must have 1 mark: ${result[1]}`);
});
