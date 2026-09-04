import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { plainTextToPmJson, migrateCommentSyntax } from '../src/lib/tiptap/plainTextLoader.js';

// --- ヘルパー ---

function paragraph(...content) {
  return { type: 'paragraph', content };
}
function text(t, ...marks) {
  return marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}
function ruby(base, reading) {
  return { type: 'ruby', attrs: { base, reading } };
}
function bold(t) {
  return { type: 'text', text: t, marks: [{ type: 'bold' }] };
}
function inlineComment(t) {
  return { type: 'text', text: t, marks: [{ type: 'inlineComment' }] };
}
function heading(level, ...content) {
  return { type: 'heading', attrs: { level }, content };
}

function getNodes(raw) {
  return plainTextToPmJson(raw).content;
}

// --- migrateCommentSyntax ---

describe('migrateCommentSyntax', () => {
  it('%%...%% を /*...*/ に変換する', () => {
    assert.equal(migrateCommentSyntax('%%note%%'), '/*note*/');
  });
  it('複数の %%...%% を一括変換', () => {
    assert.equal(migrateCommentSyntax('a%%x%%b%%y%%c'), 'a/*x*/b/*y*/c');
  });
  it('改行を含む %%...%% は変換しない', () => {
    assert.equal(migrateCommentSyntax('%%a\nb%%'), '%%a\nb%%');
  });
  it('通常テキストは変換しない', () => {
    assert.equal(migrateCommentSyntax('hello world'), 'hello world');
  });
});

// --- ルビ正常系 ---

describe('tryParseRuby — 正常系', () => {
  it('基本ルビ {漢字|かんじ}', () => {
    const nodes = getNodes('{漢字|かんじ}');
    assert.deepEqual(nodes, [paragraph(ruby('漢字', 'かんじ'))]);
  });

  it('テキスト前後にルビ 前{漢字|かんじ}後', () => {
    const nodes = getNodes('前{漢字|かんじ}後');
    assert.deepEqual(nodes, [paragraph(text('前'), ruby('漢字', 'かんじ'), text('後'))]);
  });

  it('連続ルビ {a|b}{c|d}', () => {
    const nodes = getNodes('{a|b}{c|d}');
    assert.deepEqual(nodes, [paragraph(ruby('a', 'b'), ruby('c', 'd'))]);
  });

  it('複数ルビ（スペース区切り）{a|b} {c|d}', () => {
    const nodes = getNodes('{a|b} {c|d}');
    assert.deepEqual(nodes, [paragraph(ruby('a', 'b'), text(' '), ruby('c', 'd'))]);
  });

  it('ASCII ルビ {Tokyo|とうきょう}', () => {
    const nodes = getNodes('{Tokyo|とうきょう}');
    assert.deepEqual(nodes, [paragraph(ruby('Tokyo', 'とうきょう'))]);
  });

  it('見出し内ルビ # 見出し{漢字|かんじ}', () => {
    const nodes = getNodes('# 見出し{漢字|かんじ}');
    assert.deepEqual(nodes, [heading(1, text('見出し'), ruby('漢字', 'かんじ'))]);
  });

  it('太字とルビの混在 **bold** {漢字|かんじ}', () => {
    const nodes = getNodes('**bold** {漢字|かんじ}');
    assert.deepEqual(nodes, [paragraph(bold('bold'), text(' '), ruby('漢字', 'かんじ'))]);
  });

  it('reading に記号を含む {東京|とう・きょう}', () => {
    const nodes = getNodes('{東京|とう・きょう}');
    assert.deepEqual(nodes, [paragraph(ruby('東京', 'とう・きょう'))]);
  });
});

// --- ルビ異常系（プレーンテキストにフォールバック）---

describe('tryParseRuby — 異常系（プレーンテキストにフォールバック）', () => {
  it('{base} — パイプなし → プレーンテキスト', () => {
    const nodes = getNodes('{base}');
    assert.deepEqual(nodes, [paragraph(text('{base}'))]);
  });

  it('{|reading} — base が空 → プレーンテキスト', () => {
    const nodes = getNodes('{|reading}');
    assert.deepEqual(nodes, [paragraph(text('{|reading}'))]);
  });

  it('{base|} — reading が空 → プレーンテキスト', () => {
    const nodes = getNodes('{base|}');
    assert.deepEqual(nodes, [paragraph(text('{base|}'))]);
  });

  it('{|} — base も reading も空 → プレーンテキスト', () => {
    const nodes = getNodes('{|}');
    assert.deepEqual(nodes, [paragraph(text('{|}'))]);
  });

  it('{} — 空 → プレーンテキスト', () => {
    const nodes = getNodes('{}');
    assert.deepEqual(nodes, [paragraph(text('{}'))]);
  });

  it('閉じ括弧なし {base|reading → プレーンテキスト', () => {
    const nodes = getNodes('{base|reading');
    assert.deepEqual(nodes, [paragraph(text('{base|reading'))]);
  });

  it('cross-pair: {a} c {b|c} — 最初の { はプレーン、後の {b|c} はルビ', () => {
    const nodes = getNodes('{a} c {b|c}');
    assert.deepEqual(nodes, [paragraph(text('{a} c '), ruby('b', 'c'))]);
  });

  it('ネスト: {invalid {base|reading} — 最初の { はプレーン、後の {base|reading} はルビ', () => {
    const nodes = getNodes('{invalid {base|reading}');
    assert.deepEqual(nodes, [paragraph(text('{invalid '), ruby('base', 'reading'))]);
  });

  it('inner に複数パイプ {a|b|c} — 最初の | で分割される', () => {
    const nodes = getNodes('{a|b|c}');
    // reading = "b|c" は許容（| を含む reading）
    assert.deepEqual(nodes, [paragraph(ruby('a', 'b|c'))]);
  });

  it('{ |かんじ} — base がスペースのみ → プレーンテキスト', () => {
    const nodes = getNodes('{ |かんじ}');
    assert.deepEqual(nodes, [paragraph(text('{ |かんじ}'))]);
  });

  it('{漢字| } — reading がスペースのみ → プレーンテキスト', () => {
    const nodes = getNodes('{漢字| }');
    assert.deepEqual(nodes, [paragraph(text('{漢字| }'))]);
  });

  it('{A B|あぶ} — base にスペースを含む正当なルビ → ルビノード', () => {
    const nodes = getNodes('{A B|あぶ}');
    assert.deepEqual(nodes, [paragraph(ruby('A B', 'あぶ'))]);
  });
});

// --- 太字 ---

describe('tryParseBold', () => {
  it('基本 **bold**', () => {
    const nodes = getNodes('**bold**');
    assert.deepEqual(nodes, [paragraph(bold('bold'))]);
  });

  it('単体の * はプレーンテキスト', () => {
    const nodes = getNodes('a*b');
    assert.deepEqual(nodes, [paragraph(text('a*b'))]);
  });

  it('閉じ ** なし → プレーンテキスト', () => {
    const nodes = getNodes('**unclosed');
    assert.deepEqual(nodes, [paragraph(text('**unclosed'))]);
  });

  it('テキスト前後に太字', () => {
    const nodes = getNodes('前**bold**後');
    assert.deepEqual(nodes, [paragraph(text('前'), bold('bold'), text('後'))]);
  });
});

// --- インラインコメント ---

describe('tryParseInlineComment', () => {
  it('基本 /*comment*/', () => {
    const nodes = getNodes('/*comment*/');
    assert.deepEqual(nodes, [paragraph(inlineComment('comment'))]);
  });

  it('単体の / はプレーンテキスト', () => {
    const nodes = getNodes('a/b');
    assert.deepEqual(nodes, [paragraph(text('a/b'))]);
  });

  it('/* のみ（閉じなし）→ プレーンテキスト', () => {
    const nodes = getNodes('/*unclosed');
    assert.deepEqual(nodes, [paragraph(text('/*unclosed'))]);
  });

  it('複数行コメント /* line1\\nline2 */ → hardBreak に inlineComment mark を付与', () => {
    const nodes = getNodes('/*line1\nline2*/');
    assert.deepEqual(nodes, [
      paragraph(
        inlineComment('line1'),
        { type: 'hardBreak', marks: [{ type: 'inlineComment' }] },
        inlineComment('line2'),
      ),
    ]);
  });

  it('3行コメント /* a\\nb\\nc */ → 2つの hardBreak(inlineComment mark) を挟んだ inlineComment ノード', () => {
    const nodes = getNodes('/*a\nb\nc*/');
    assert.deepEqual(nodes, [
      paragraph(
        inlineComment('a'),
        { type: 'hardBreak', marks: [{ type: 'inlineComment' }] },
        inlineComment('b'),
        { type: 'hardBreak', marks: [{ type: 'inlineComment' }] },
        inlineComment('c'),
      ),
    ]);
  });

  it('コメント開始直後に改行 /*\\nfoo*/ → hardBreak(inlineComment mark) が先頭', () => {
    // textSerializer の !inComment && breakInComment ケースのラウンドトリップ起点
    const nodes = getNodes('/*\nfoo*/');
    assert.deepEqual(nodes, [
      paragraph({ type: 'hardBreak', marks: [{ type: 'inlineComment' }] }, inlineComment('foo')),
    ]);
  });

  it('空コメント /**/ → テキストなし段落', () => {
    const nodes = getNodes('/**/');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'paragraph');
    assert.ok(!nodes[0].content || nodes[0].content.length === 0);
  });

  it('コメント前後にテキスト 前/*note*/後', () => {
    const nodes = getNodes('前/*note*/後');
    assert.deepEqual(nodes, [paragraph(text('前'), inlineComment('note'), text('後'))]);
  });
});

// --- 複数段落ブロックコメント ---

describe('plainTextToPmJson — 複数段落 /* */ ブロックコメント', () => {
  it('/* para1\\n\\npara2 */ → 2つの commentParagraph ノード', () => {
    const nodes = getNodes('/* para1\n\npara2 */');
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].type, 'commentParagraph');
    assert.equal(nodes[1].type, 'commentParagraph');
    assert.deepEqual(nodes[0].content, [text('para1')]);
    assert.deepEqual(nodes[1].content, [text('para2')]);
  });

  it('ブロックコメントの前後に通常段落がある', () => {
    const nodes = getNodes('前段落\n\n/* コメント1\n\nコメント2 */\n\n後段落');
    assert.equal(nodes.length, 4);
    assert.equal(nodes[0].type, 'paragraph');
    assert.equal(nodes[1].type, 'commentParagraph');
    assert.equal(nodes[2].type, 'commentParagraph');
    assert.equal(nodes[3].type, 'paragraph');
  });

  it('3段落ブロックコメント → 3つの commentParagraph', () => {
    const nodes = getNodes('/* A\n\nB\n\nC */');
    assert.equal(nodes.length, 3);
    assert.ok(nodes.every((n) => n.type === 'commentParagraph'));
  });

  it('単一段落 /* */ はインラインコメントとして扱う（commentParagraph にならない）', () => {
    const nodes = getNodes('/* inline */');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'paragraph');
    assert.ok(nodes[0].content.some((n) => n.marks?.some((m) => m.type === 'inlineComment')));
  });
});

// --- ブロック要素 ---

describe('plainTextToPmJson — ブロック要素', () => {
  it('空文字 → 空パラグラフ', () => {
    const nodes = getNodes('');
    assert.deepEqual(nodes, [{ type: 'paragraph' }]);
  });

  it('null → 空パラグラフ', () => {
    const nodes = plainTextToPmJson(null).content;
    assert.deepEqual(nodes, [{ type: 'paragraph' }]);
  });

  it('---（3つ以上）→ horizontalRule', () => {
    const nodes = getNodes('---');
    assert.deepEqual(nodes, [{ type: 'horizontalRule' }]);
  });

  it('# 見出し → heading level 1', () => {
    const nodes = getNodes('# タイトル');
    assert.deepEqual(nodes, [heading(1, text('タイトル'))]);
  });

  it('## 見出し → heading level 2', () => {
    const nodes = getNodes('## 第2節');
    assert.deepEqual(nodes, [heading(2, text('第2節'))]);
  });

  it('// コメント → slashComment', () => {
    const nodes = getNodes('// コメント');
    assert.deepEqual(nodes, [
      { type: 'slashComment', content: [{ type: 'text', text: 'コメント' }] },
    ]);
  });

  it('空行で段落分割', () => {
    const nodes = getNodes('段落1\n\n段落2');
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].type, 'paragraph');
    assert.equal(nodes[1].type, 'paragraph');
  });

  it('同一段落内改行 → hardBreak', () => {
    const nodes = getNodes('行1\n行2');
    const p = nodes[0];
    assert.equal(p.type, 'paragraph');
    assert.ok(p.content.some((n) => n.type === 'hardBreak'));
  });

  it('CRLF 入力 → LF と同等にパースされる（Windows インポート対応）', () => {
    const crlfNodes = getNodes('段落1\r\n\r\n段落2');
    const lfNodes = getNodes('段落1\n\n段落2');
    assert.deepEqual(crlfNodes, lfNodes);
  });

  it('CRLF 入力 — // コメントが正しくパースされる', () => {
    const nodes = getNodes('// コメント\r\n本文');
    assert.equal(nodes[0].type, 'slashComment');
    assert.equal(nodes[1].type, 'paragraph');
    assert.deepEqual(nodes[1].content, [text('本文')]);
  });

  it('CR のみの入力 → LF と同等にパースされる', () => {
    const crNodes = getNodes('段落1\r\r段落2');
    const lfNodes = getNodes('段落1\n\n段落2');
    assert.deepEqual(crNodes, lfNodes);
  });
});
