import { describe, it, expect } from 'vitest';
import { getParagraphOffsets, docToLinesText } from './utils';
import { getDialogueRanges, filterByScope } from './scope';
import { SCOPE } from './types';
import { notationRules } from './rules/notation';
import { syntaxRules } from './rules/syntax';
import { kinsokuRules } from './rules/kinsoku';
import { styleRules } from './rules/style';

// ProseMirror doc の最小スタブ
function stubDoc(traversal) {
  return {
    descendants(cb) {
      for (const [node, pos] of traversal) {
        cb(node, pos);
      }
    },
  };
}

const para = (pos) => [{ isTextblock: true, isText: false, type: { name: 'paragraph' } }, pos];
const text = (t, pos) => [{ isTextblock: false, isText: true, text: t, type: { name: 'text' } }, pos];
const hardBreak = (pos) => [{ isTextblock: false, isText: false, type: { name: 'hardBreak' } }, pos];
const ruby = (base, reading, pos) => [
  { isTextblock: false, isText: false, type: { name: 'ruby' }, attrs: { base, reading } },
  pos,
];
const slashComment = (pos) => [{ isTextblock: true, isText: false, type: { name: 'slashComment' } }, pos];

// ---------------------------------------------------------------------------
// getParagraphOffsets
// ---------------------------------------------------------------------------
describe('getParagraphOffsets', () => {
  it('単一行を返す', () => {
    const result = getParagraphOffsets('hello');
    expect(result).toEqual([{ text: 'hello', offset: 0 }]);
  });

  it('複数行のオフセットを正しく計算する', () => {
    const result = getParagraphOffsets('hello\nworld');
    expect(result).toEqual([
      { text: 'hello', offset: 0 },
      { text: 'world', offset: 6 },
    ]);
  });

  it('\\r\\n 改行を \\n と同じに扱う', () => {
    const result = getParagraphOffsets('hello\r\nworld');
    expect(result[0].text).toBe('hello');
    expect(result[1].text).toBe('world');
    // \r が末尾に残らない
    expect(result[0].text).not.toMatch(/\r$/);
    expect(result[1].text).not.toMatch(/\r$/);
  });

  it('空行を含む場合', () => {
    const result = getParagraphOffsets('a\n\nb');
    expect(result).toHaveLength(3);
    expect(result[1].text).toBe('');
    expect(result[2].text).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// docToLinesText
// ---------------------------------------------------------------------------
describe('docToLinesText', () => {
  it('単一段落のテキストと PM 座標を返す', () => {
    // para(0) → pmBase = 1, text("hello", 1)
    const doc = stubDoc([para(0), text('hello', 1)]);
    const { text: t, toPmPos } = docToLinesText(doc);
    expect(t).toBe('hello');
    expect(toPmPos(0)).toBe(1);
    expect(toPmPos(4)).toBe(5);
  });

  it('2段落は U+2029 で区切られ、PM 座標が正しくジャンプする', () => {
    // para(0), text("ab",1), para(4), text("cd",5)
    // para(4): nodeSize= 2+2=4, so second para at pos 4
    const doc = stubDoc([para(0), text('ab', 1), para(4), text('cd', 5)]);
    const { text: t, toPmPos } = docToLinesText(doc);
    expect(t).toBe('ab cd');
    expect(toPmPos(0)).toBe(1); // 'a' in first para
    expect(toPmPos(1)).toBe(2); // 'b' in first para
    // offset 2 = U+2029 → maps to pmBase of first block + 2 (closing region)
    expect(toPmPos(3)).toBe(5); // 'c' in second para (pmBase=5)
    expect(toPmPos(4)).toBe(6); // 'd' in second para
  });

  it('hardBreak は 1 PM position を占め座標ずれが起きない', () => {
    // para(0), text("hello",1), hardBreak(6), text("world",7)
    const doc = stubDoc([para(0), text('hello', 1), hardBreak(6), text('world', 7)]);
    const { text: t, toPmPos } = docToLinesText(doc);
    expect(t).toBe('hello\nworld');
    expect(toPmPos(5)).toBe(6); // hardBreak の PM 位置
    expect(toPmPos(6)).toBe(7); // 'w' = hardBreak の次
    expect(toPmPos(10)).toBe(11);
  });

  it('ruby atom は 1 PM position を占め、後続テキストの座標がずれない', () => {
    // para(0), text("AB",1), ruby("女性","じょせい",3), text("CD",4)
    const doc = stubDoc([para(0), text('AB', 1), ruby('女性', 'じょせい', 3), text('CD', 4)]);
    const { text: t, toPmPos } = docToLinesText(doc);
    // ruby は U+FFFD（固定プレースホルダ）として計上
    expect(t).toBe('AB�CD');
    expect(toPmPos(0)).toBe(1); // 'A'
    expect(toPmPos(1)).toBe(2); // 'B'
    expect(toPmPos(2)).toBe(3); // ruby atom
    expect(toPmPos(3)).toBe(4); // 'C' — ruby が 1 position だけ進んでいる
    expect(toPmPos(4)).toBe(5); // 'D'
  });

  it('ruby を無視すると後続テキストの座標がずれることを示す（回帰テスト）', () => {
    // ruby がある場合、ruby を無視すれば toPmPos(3) = 3 になってしまうが
    // 修正後は toPmPos(3) = 4（ruby の PM position=3 を挟むため）
    const doc = stubDoc([para(0), text('AB', 1), ruby('女性', 'じょせい', 3), text('CD', 4)]);
    const { toPmPos } = docToLinesText(doc);
    // 'C' は PM position 4 であるべき（ruby が pos=3 を占める）
    expect(toPmPos(3)).toBe(4);
  });

  it('slashComment ノードは本文チェック対象から除外される（段落境界にも含まれない）', () => {
    // slashComment(0) の後に para(4), text("hello",5) → slashComment は blockStarts に入らない
    const doc = stubDoc([slashComment(0), para(4), text('hello', 5)]);
    const { text: t, toPmPos } = docToLinesText(doc);
    expect(t).toBe('hello');
    expect(toPmPos(0)).toBe(5);
  });

  it('空の doc は空文字列と null を返す toPmPos', () => {
    const doc = stubDoc([]);
    const { text: t, toPmPos } = docToLinesText(doc);
    expect(t).toBe('');
    expect(toPmPos(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDialogueRanges
// ---------------------------------------------------------------------------
describe('getDialogueRanges', () => {
  it('会話文なし → 空配列', () => {
    expect(getDialogueRanges('地の文だけ')).toEqual([]);
  });

  it('「...」を検出する', () => {
    const ranges = getDialogueRanges('彼は「こんにちは」と言った');
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 2, end: 9 }); // end = 「index(2) + 4chars + 」 = i+1 = 9
  });

  it('『...』を検出する', () => {
    const ranges = getDialogueRanges('本の題名は『桜』だ');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(5);
  });

  it('「」と『』を混在して検出する', () => {
    const ranges = getDialogueRanges('「A」と『B』');
    expect(ranges).toHaveLength(2);
  });

  it('閉じ括弧なしの 「 は範囲として返さない', () => {
    expect(getDialogueRanges('「未閉鎖のまま')).toHaveLength(0);
  });

  it('閉じ括弧欠落でも U+2029（段落境界）以降のテキストに汚染しない', () => {
    // docToLinesText は段落境界を   として出力する
    const ranges = getDialogueRanges('「未閉鎖 次の段落');
    expect(ranges).toHaveLength(0);
  });

  it('前段落で括弧欠落があっても後続段落の正常な会話文を検出する', () => {
    const ranges = getDialogueRanges('「未閉鎖 地の文「正常」続き');
    expect(ranges).toHaveLength(1);
    // 後続段落の「正常」を検出
    expect(ranges[0].start).toBeGreaterThan(4); //   より後ろ
  });

  it('hardBreak（\\n）は段落境界ではないため会話範囲をリセットしない', () => {
    // 「A\nB」は 1 段落内の hardBreak をまたぐ会話文 → 範囲として返す
    const ranges = getDialogueRanges('「A\nB」');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(0);
  });

  it('「の中に別の「があっても外側のペアのみ返す', () => {
    // 「A「B」C → 最初の「が activeOpen、「B」で範囲確定
    const ranges = getDialogueRanges('前「A「B」C」後');
    expect(ranges).toHaveLength(1);
    // 外側ではなく最初にマッチした内側が返る（単純な O(N) 実装の仕様）
    expect(ranges[0].start).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// filterByScope
// ---------------------------------------------------------------------------
describe('filterByScope', () => {
  const text = '地「会話」文';
  // 「会話」は start=1, end=5
  const inside = { from: 2, to: 4 };   // 会話内
  const outside = { from: 0, to: 1 };  // 地の文内
  const overlap = { from: 0, to: 3 };  // 境界をまたぐ

  it('SCOPE.ALL は全件通す', () => {
    expect(filterByScope([inside, outside, overlap], text, SCOPE.ALL)).toHaveLength(3);
  });

  it('SCOPE.OUTSIDE_DIALOGUE は会話文内・交差マッチを除外する', () => {
    const result = filterByScope([inside, outside, overlap], text, SCOPE.OUTSIDE_DIALOGUE);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(outside);
  });

  it('SCOPE.DIALOGUE_ONLY は会話文内のみ通す', () => {
    const result = filterByScope([inside, outside, overlap], text, SCOPE.DIALOGUE_ONLY);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(inside);
  });
});

// ---------------------------------------------------------------------------
// notation rules
// ---------------------------------------------------------------------------
describe('notation/punct-repeat', () => {
  const rule = notationRules.find((r) => r.id === 'notation/punct-repeat');

  it('読点の連続を検出する', () => {
    const results = rule.check('良い、、場所');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('、、');
  });

  it('句点の連続を検出する', () => {
    expect(rule.check('終わり。。')).toHaveLength(1);
  });

  it('単独の句読点は検出しない', () => {
    expect(rule.check('良い、場所。')).toHaveLength(0);
  });
});

describe('notation/ellipsis', () => {
  const rule = notationRules.find((r) => r.id === 'notation/ellipsis');

  it('... を検出して … を提案する', () => {
    const results = rule.check('そして...');
    expect(results).toHaveLength(1);
    expect(results[0].suggestion).toBe('…');
  });

  it('。。。を検出して … を提案する', () => {
    const results = rule.check('そして。。。');
    expect(results).toHaveLength(1);
    expect(results[0].suggestion).toBe('…');
  });

  it('… はそのまま通す', () => {
    expect(rule.check('そして…')).toHaveLength(0);
  });
});

describe('notation/dash', () => {
  const rule = notationRules.find((r) => r.id === 'notation/dash');

  it('-- を検出して —— を提案する', () => {
    const results = rule.check('続き--その後');
    expect(results).toHaveLength(1);
    expect(results[0].suggestion).toBe('——');
  });

  it('—— はそのまま通す', () => {
    expect(rule.check('続き——その後')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// syntax rules
// ---------------------------------------------------------------------------
describe('syntax/unmatched-bracket', () => {
  const rule = syntaxRules.find((r) => r.id === 'syntax/unmatched-bracket');

  it('対になった「」は検出しない', () => {
    expect(rule.check('「こんにちは」')).toHaveLength(0);
  });

  it('対になった『』は検出しない', () => {
    expect(rule.check('『タイトル』')).toHaveLength(0);
  });

  it('閉じのない「を検出する', () => {
    const results = rule.check('「未閉鎖');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('「');
  });

  it('開きのない」を検出する', () => {
    const results = rule.check('未開放」');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('」');
  });

  it('複数の不対称を全て検出し位置順に返す', () => {
    const results = rule.check('「A」B」');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('」');
  });

  it('段落境界（U+2029）をまたいで未閉鎖括弧を引き継がない', () => {
    // 「が段落1で未閉鎖でも、段落2では別個にカウント → 段落1の「のみ警告
    const results = rule.check('「段落1 段落2');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('「');
    expect(results[0].from).toBe(0);
  });

  it('hardBreak（\n）をまたぐ括弧ペアは不対称として検出しない', () => {
    // \n は hardBreak（段落内改行）→ 括弧スタックをリセットしない
    const results = rule.check('「段落1\n段落2」');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// kinsoku rules
// ---------------------------------------------------------------------------
describe('kinsoku/line-start', () => {
  const rule = kinsokuRules.find((r) => r.id === 'kinsoku/line-start');

  it('行頭禁則文字（、）を検出する', () => {
    const results = rule.check('、ここから');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('、');
  });

  it('行頭禁則文字（っ）を検出する', () => {
    expect(rule.check('っと驚く')).toHaveLength(1);
  });

  it('通常文字で始まる場合は検出しない', () => {
    expect(rule.check('普通の文')).toHaveLength(0);
  });

  it('複数段落の2段落目に禁則があっても検出する', () => {
    const results = rule.check('普通\n、禁則');
    expect(results).toHaveLength(1);
    expect(results[0].from).toBe(3); // 2段落目の先頭（offset=3+leadOffset=0）
  });

  it('\\r\\n 改行後の行頭禁則を検出する（Windows改行対応）', () => {
    const results = rule.check('普通\r\n、禁則');
    expect(results).toHaveLength(1);
  });
});

describe('kinsoku/line-end', () => {
  const rule = kinsokuRules.find((r) => r.id === 'kinsoku/line-end');

  it('行末禁則文字（「）を検出する', () => {
    const results = rule.check('続き「');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('「');
  });

  it('通常文字で終わる場合は検出しない', () => {
    expect(rule.check('普通の文。')).toHaveLength(0);
  });

  it('\\r\\n 改行行の末尾禁則を検出する（\\r が残らない）', () => {
    // \r があると LINE_END_FORBIDDEN の $ にマッチしない旧バグの回帰テスト
    const results = rule.check('続き「\r\n次の行');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('「');
  });

  it('末尾にスペースがあっても行末禁則を検出する（trimEnd 対応）', () => {
    // 末尾の空白が残ると LINE_END_FORBIDDEN の $ にマッチしない
    const results = rule.check('続き「  ');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('「');
  });
});

// ---------------------------------------------------------------------------
// style rules
// ---------------------------------------------------------------------------
describe('style/long-sentence', () => {
  const rule = styleRules.find((r) => r.id === 'style/long-sentence');

  it('120字以下の段落は検出しない', () => {
    expect(rule.check('あ'.repeat(120))).toHaveLength(0);
  });

  it('121字の段落を検出する', () => {
    const results = rule.check('あ'.repeat(121));
    expect(results).toHaveLength(1);
  });

  it('複数段落では超過している段落だけ検出する', () => {
    const short = 'あ'.repeat(10);
    const long = 'あ'.repeat(121);
    const results = rule.check(`${short}\n${long}`);
    expect(results).toHaveLength(1);
    // 2段落目の開始位置（11）以降であること
    expect(results[0].from).toBeGreaterThanOrEqual(11);
  });
});

describe('style/repeated-particle', () => {
  const rule = styleRules.find((r) => r.id === 'style/repeated-particle');

  it('同一助詞の連続を検出する', () => {
    const results = rule.check('彼が声が聞こえた');
    expect(results).toHaveLength(1);
  });

  it('同一助詞が離れた位置にある場合も検出する', () => {
    const results = rule.check('彼が遠くに見える木が揺れた');
    expect(results).toHaveLength(1);
  });

  it('異なる助詞は検出しない', () => {
    expect(rule.check('彼が彼女に話しかけた')).toHaveLength(0);
  });

  it('重なりマッチを両方検出する（re.lastIndex = m.index + 1 の確認）', () => {
    // "がAが" + "がBが" で 2 マッチあるべき
    const results = rule.check('XがAがBが');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('文の区切り（。）をまたいで同一助詞を検出しない', () => {
    // 「が」が文をまたいでマッチしないこと
    const results = rule.check('彼が行った。私が残った。');
    expect(results).toHaveLength(0);
  });

  it('直接連続する同一助詞（がが）を検出する', () => {
    const results = rule.check('彼がが来た');
    expect(results).toHaveLength(1);
  });
});
