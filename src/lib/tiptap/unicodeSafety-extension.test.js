import { describe, it, expect } from 'vitest';
import { collectFindingRanges } from './UnicodeSafetyExtension';

// ProseMirror doc の最小スタブ。descendants(cb) で text node を pos 付きで返す。
function stubDoc(textNodes) {
  return {
    descendants(cb) {
      for (const { text, pos } of textNodes) {
        cb({ isText: true, text }, pos);
      }
    },
  };
}

describe('collectFindingRanges', () => {
  it('text node 内の finding を pos + index にマップする', () => {
    // 'a<RLO>b' : RLO(deny) は index 1 → from = pos(5) + 1
    const ranges = collectFindingRanges(stubDoc([{ text: 'a‮b', pos: 5 }]));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ from: 6, to: 7, severity: 'deny' });
  });

  it('複数 text node を跨いで絶対位置を返す', () => {
    const ranges = collectFindingRanges(
      stubDoc([
        { text: 'x​y', pos: 1 }, // ZWSP(warn) index 1 → from 2
        { text: 'z‮w', pos: 10 }, // RLO(deny) index 1 → from 11
      ]),
    );
    expect(ranges.map((r) => r.from)).toEqual([2, 11]);
    expect(ranges.map((r) => r.severity)).toEqual(['warn', 'deny']);
  });

  it('clean な text node は空配列', () => {
    expect(collectFindingRanges(stubDoc([{ text: 'hello world', pos: 0 }]))).toEqual([]);
  });
});

// ruby node スタブ（atom:true、base/reading を attrs に持つ）
function stubRubyDoc(nodes) {
  return {
    descendants(cb) {
      for (const { attrs, pos, nodeSize } of nodes) {
        cb({ isText: false, type: { name: 'ruby' }, attrs, nodeSize }, pos);
      }
    },
  };
}

describe('collectFindingRanges — ruby node', () => {
  it('base に RLO が含まれる場合 deny ウィジェットをノード位置に出す', () => {
    const ranges = collectFindingRanges(
      stubRubyDoc([{ attrs: { base: 'a‮b', reading: 'ふりがな' }, pos: 3, nodeSize: 1 }]),
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ from: 3, to: 4, severity: 'deny' });
  });

  it('reading に ZWSP が含まれる場合 warn ウィジェットをノード位置に出す', () => {
    const ranges = collectFindingRanges(
      stubRubyDoc([{ attrs: { base: '漢字', reading: 'か​な' }, pos: 5, nodeSize: 1 }]),
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ from: 5, severity: 'warn' });
  });

  it('base が deny、reading が warn のとき deny が優先される', () => {
    const ranges = collectFindingRanges(
      stubRubyDoc([{ attrs: { base: '‮悪意', reading: 'か​な' }, pos: 0, nodeSize: 1 }]),
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0].severity).toBe('deny');
  });

  it('clean な ruby node は空配列', () => {
    const ranges = collectFindingRanges(
      stubRubyDoc([{ attrs: { base: '漢字', reading: 'かんじ' }, pos: 0, nodeSize: 1 }]),
    );
    expect(ranges).toEqual([]);
  });
});
