import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  toPlainText,
  stripComments,
  toWordCountText,
  toSiteText,
  toSiteWordCountText,
} from './plainText';

const __dir = dirname(fileURLToPath(import.meta.url));

describe('toPlainText', () => {
  it('空文字は空文字を返す', () => {
    expect(toPlainText('')).toBe('');
    expect(toPlainText(null)).toBe('');
    expect(toPlainText(undefined)).toBe('');
  });

  it('// 行コメントを除去する', () => {
    expect(toPlainText('本文\n// コメント\n続き')).toBe('本文\n\n続き');
  });

  it('/* */ インラインコメントを除去する', () => {
    expect(toPlainText('テキスト/*メモ*/続き')).toBe('テキスト続き');
  });

  it('%% アノテーションマーカーを除去する', () => {
    expect(toPlainText('テキスト%%注記%%続き')).toBe('テキスト続き');
  });

  it('見出し記号を除去する', () => {
    expect(toPlainText('# 第一章\n## 節\n### 小節')).toBe('第一章\n節\n小節');
  });

  it('ボールドのマーカーを除去してテキストを保持する', () => {
    expect(toPlainText('**強調**テキスト')).toBe('強調テキスト');
  });

  it('ボールド内にアスタリスクを含む場合も正しく除去する', () => {
    // [^*]* では **A*B** にマッチしないバグの回帰テスト
    expect(toPlainText('**A*B**')).toBe('A*B');
    expect(toPlainText('**前*後**テスト')).toBe('前*後テスト');
  });

  it('ルビ記法を漢字（かんじ）形式に変換する', () => {
    expect(toPlainText('彼は{薔薇|ばら}を持った')).toBe('彼は薔薇（ばら）を持った');
  });

  it('水平線はそのまま --- で残す', () => {
    expect(toPlainText('上\n---\n下')).toBe('上\n---\n下');
    expect(toPlainText('上\n------\n下')).toBe('上\n------\n下');
  });

  it('3行以上の空行を最大2行に正規化する', () => {
    expect(toPlainText('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('stripComments は行コメントとインラインコメントを除去する', () => {
    expect(stripComments('本文\n// コメント\n続き')).toBe('本文\n\n続き');
    expect(stripComments('テキスト/*メモ*/続き')).toBe('テキスト続き');
    expect(stripComments('テキスト/*含む*アスタリスク*/続き')).toBe('テキスト続き');
  });

  it('stripComments は CRLF を LF に正規化してからコメントを除去する', () => {
    expect(stripComments('本文\r\n// コメント\r\n続き')).toBe('本文\n\n続き');
    expect(stripComments('テキスト\r\n/*メモ*/\r\n続き')).toBe('テキスト\n\n続き');
  });

  it('複合: Markdown/ルビ混在テキストを正しく変換する', () => {
    const input = [
      '# 第一章',
      '',
      '彼は**強く**{叫|さけ}んだ。',
      '',
      '// 執筆メモ',
      '',
      '---',
      '',
      '%%ハイライト%%終わり。',
    ].join('\n');
    const expected = ['第一章', '', '彼は強く叫（さけ）んだ。', '', '---', '', '終わり。'].join(
      '\n',
    );
    expect(toPlainText(input)).toBe(expected);
  });
});

describe('toWordCountText', () => {
  it('空文字は空文字を返す', () => {
    expect(toWordCountText('')).toBe('');
    expect(toWordCountText(null)).toBe('');
    expect(toWordCountText(undefined)).toBe('');
  });

  it('ルビを本文のみに変換する（読み仮名を除外）', () => {
    expect(toWordCountText('彼は{薔薇|ばら}を持った')).toBe('彼は薔薇を持った');
  });

  it('水平線はそのまま --- で残す', () => {
    expect(toWordCountText('上\n---\n下')).toBe('上\n---\n下');
  });

  it('コメント・アノテーション・ボールド・見出しも除去する', () => {
    expect(toWordCountText('// メモ\n**強調**テキスト')).toBe('強調テキスト');
    expect(toWordCountText('# 章\n本文')).toBe('章\n本文');
  });
});

describe('toSiteWordCountText', () => {
  it('空文字は空文字を返す', () => {
    expect(toSiteWordCountText('')).toBe('');
    expect(toSiteWordCountText(null)).toBe('');
    expect(toSiteWordCountText(undefined)).toBe('');
  });

  it('ルビ記法をそのまま保持する（記号も文字数に含まれる）', () => {
    const result = toSiteWordCountText('彼は{薔薇|ばら}を持った');
    expect(result).toBe('彼は{薔薇|ばら}を持った');
    expect(result.replace(/\s/g, '').length).toBe(13);
  });

  it('toWordCountText より多い文字数を返す（読み仮名・記号分）', () => {
    const text = '{薔薇|ばら}';
    const offline = toWordCountText(text).replace(/\s/g, '').length;
    const site = toSiteWordCountText(text).replace(/\s/g, '').length;
    expect(site).toBeGreaterThan(offline);
  });

  it('コメント・アノテーション・見出し記号は除去する', () => {
    expect(toSiteWordCountText('// メモ\n**強調**テキスト')).toBe('強調テキスト');
    expect(toSiteWordCountText('# 章\n本文')).toBe('章\n本文');
    expect(toSiteWordCountText('テキスト%%注記%%続き')).toBe('テキスト続き');
  });
});

describe('toSiteText', () => {
  it('rubyFormat が undefined のときルビ記法をそのまま残す', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', undefined)).toBe('彼は{薔薇|ばら}を持った');
  });

  it('rubyFormat が none のときルビ記法をそのまま残す', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'none')).toBe('彼は{薔薇|ばら}を持った');
  });

  it('rubyFormat kakuyomu でカクヨム/なろう形式に変換する', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'kakuyomu')).toBe('彼は｜薔薇《ばら》を持った');
  });

  it('rubyFormat pixiv で pixiv 形式に変換する', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'pixiv')).toBe('彼は[[rb:薔薇 > ばら]]を持った');
  });

  it('rubyFormat novelup でノベルアップ+ 形式に変換する', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'novelup')).toBe('彼は薔薇《ばら》を持った');
  });

  it('rubyFormat custom で customRuby テンプレートを適用する', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'custom', '({base}/{reading})')).toBe(
      '彼は(薔薇/ばら)を持った',
    );
  });

  it('rubyFormat custom で customRuby が空のときルビ記法をそのまま残す', () => {
    expect(toSiteText('彼は{薔薇|ばら}を持った', 'custom', '')).toBe('彼は{薔薇|ばら}を持った');
  });

  it('複合: コメント除去とルビ変換が同時に動作する', () => {
    const input = '# 章\n// メモ\n{漢字|かんじ}の本文';
    expect(toSiteText(input, 'kakuyomu')).toBe('章\n\n｜漢字《かんじ》の本文');
  });

  it('複数ルビがある場合にすべて変換する', () => {
    expect(toSiteText('{薔薇|ばら}と{百合|ゆり}', 'kakuyomu')).toBe(
      '｜薔薇《ばら》と｜百合《ゆり》',
    );
  });

  it('カスタムテンプレートで {base} を複数回使うと全箇所が置換される', () => {
    expect(toSiteText('{薔薇|ばら}', 'custom', '({base}/{reading})/{base}')).toBe(
      '(薔薇/ばら)/薔薇',
    );
  });

  it('テンプレートで {base} と {reading} が複数回ともすべて置換される', () => {
    expect(toSiteText('{薔薇|ばら}', 'custom', '{base}({reading})/{base}/{reading}')).toBe(
      '薔薇(ばら)/薔薇/ばら',
    );
  });
});

describe('ドキュメント整合性', () => {
  it('plainText.js の export function が PLAIN_TEXT_RULES.md に記載されている', () => {
    const src = readFileSync(join(__dir, 'plainText.js'), 'utf-8');
    const docs = readFileSync(join(__dir, '../../docs/PLAIN_TEXT_RULES.md'), 'utf-8');
    const exportedFns = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    for (const fn of exportedFns) {
      expect(docs, `${fn}() が PLAIN_TEXT_RULES.md に記載されていません`).toContain(`${fn}()`);
    }
  });
});
