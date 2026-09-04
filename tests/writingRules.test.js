import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWritingRules, DEFAULT_RULES } from '../src/lib/writingRules.js';

function rule(id) {
  return [{ ...DEFAULT_RULES.find((r) => r.id === id), enabled: true }];
}

// --- indent ---

test('indent: 通常行に全角スペースが付与される', () => {
  const result = applyWritingRules('こんにちは', rule('indent'));
  assert.equal(result, '　こんにちは');
});

test('indent: # 始まりの行はスキップ', () => {
  const result = applyWritingRules('# 見出し', rule('indent'));
  assert.equal(result, '# 見出し');
});

test('indent: / 始まりの行はスキップ', () => {
  const result = applyWritingRules('/コメント', rule('indent'));
  assert.equal(result, '/コメント');
});

test('indent: - 始まりの行はスキップ', () => {
  const result = applyWritingRules('- リスト', rule('indent'));
  assert.equal(result, '- リスト');
});

test('indent: * 始まりの行はスキップ', () => {
  const result = applyWritingRules('* アスタリスク', rule('indent'));
  assert.equal(result, '* アスタリスク');
});

test('indent: > 始まりの行はスキップ', () => {
  const result = applyWritingRules('> 引用', rule('indent'));
  assert.equal(result, '> 引用');
});

test('indent: 既に全角スペース始まりの行はスキップ', () => {
  const result = applyWritingRules('　既存インデント', rule('indent'));
  assert.equal(result, '　既存インデント');
});

test('indent: 空行はスキップ', () => {
  const result = applyWritingRules('', rule('indent'));
  assert.equal(result, '');
});

test('indent: 複数行 — 通常行のみ付与', () => {
  const input = '本文\n# 見出し\n続き';
  const result = applyWritingRules(input, rule('indent'));
  assert.equal(result, '　本文\n# 見出し\n　続き');
});

test('indent: ルビ記法 {漢字|かんじ} を含む行に全角スペースが付与される', () => {
  const result = applyWritingRules('{漢字|かんじ}を読む', rule('indent'));
  assert.equal(result, '　{漢字|かんじ}を読む');
});

// --- rm_dbl_sp ---

test('rm_dbl_sp: 2個以上の全角スペースを1個に正規化', () => {
  const result = applyWritingRules('あ　　い', rule('rm_dbl_sp'));
  assert.equal(result, 'あ　い');
});

test('rm_dbl_sp: 3個の全角スペースも1個に', () => {
  const result = applyWritingRules('あ　　　い', rule('rm_dbl_sp'));
  assert.equal(result, 'あ　い');
});

test('rm_dbl_sp: 1個の全角スペースはそのまま', () => {
  const result = applyWritingRules('あ　い', rule('rm_dbl_sp'));
  assert.equal(result, 'あ　い');
});

// --- bracket_sp ---

test('bracket_sp: 全角括弧内のスペース除去 （ 言葉 ）', () => {
  const result = applyWritingRules('（ 言葉 ）', rule('bracket_sp'));
  assert.equal(result, '（言葉）');
});

test('bracket_sp: 鍵括弧内のスペース除去', () => {
  const result = applyWritingRules('「 言葉 」', rule('bracket_sp'));
  assert.equal(result, '「言葉」');
});

test('bracket_sp: 全角波括弧内のスペース除去 ｛ 言葉 ｝', () => {
  const result = applyWritingRules('｛ 言葉 ｝', rule('bracket_sp'));
  assert.equal(result, '｛言葉｝');
});

test('bracket_sp: ｛」 のような複合記号パターンでも誤処理しない', () => {
  const result = applyWritingRules('｛」と言った', rule('bracket_sp'));
  assert.equal(result, '｛」と言った');
});

test('bracket_sp: ｛） のような複合記号パターンでも誤処理しない', () => {
  const result = applyWritingRules('｛）と言った', rule('bracket_sp'));
  assert.equal(result, '｛）と言った');
});

test('bracket_sp: ルビ記法 {漢字|かんじ} は半角{}のため変換されない', () => {
  const result = applyWritingRules('{ 漢字 | かんじ }', rule('bracket_sp'));
  assert.equal(result, '{ 漢字 | かんじ }');
});

// --- 組み合わせ・disabled ---

test('複数ルール有効: indent + rm_dbl_sp', () => {
  const rules = [
    { ...DEFAULT_RULES.find((r) => r.id === 'indent'), enabled: true },
    { ...DEFAULT_RULES.find((r) => r.id === 'rm_dbl_sp'), enabled: true },
  ];
  const result = applyWritingRules('あ　　い', rules);
  assert.equal(result, '　あ　い');
});

test('enabled: false のルールはスキップ', () => {
  const result = applyWritingRules('こんにちは', [{ id: 'indent', enabled: false }]);
  assert.equal(result, 'こんにちは');
});

// --- DEFAULT_RULES の形状 ---

test('DEFAULT_RULES は配列', () => {
  assert.ok(Array.isArray(DEFAULT_RULES));
  assert.ok(DEFAULT_RULES.length > 0);
});

test('DEFAULT_RULES の各要素が必須プロパティを持つ', () => {
  for (const r of DEFAULT_RULES) {
    assert.ok('id' in r, `id missing in ${JSON.stringify(r)}`);
    assert.ok('label' in r, `label missing`);
    assert.ok('desc' in r, `desc missing`);
    assert.ok('enabled' in r, `enabled missing`);
  }
});

test('DEFAULT_RULES の id は indent / rm_dbl_sp / bracket_sp を含む', () => {
  const ids = DEFAULT_RULES.map((r) => r.id);
  assert.ok(ids.includes('indent'));
  assert.ok(ids.includes('rm_dbl_sp'));
  assert.ok(ids.includes('bracket_sp'));
});
