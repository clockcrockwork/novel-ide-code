import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeJudgment,
  inferDispositionReason,
  classifyArea,
  buildDetailedItems,
  buildRiskPatterns,
  renderRiskPatternsMd,
} from '../scripts/analyze-pr-history.js';

// --- judgment_norm 正規化テーブル（実データの判断セルバリアント。#353 段階B） ---

const NORM_CASES = [
  ['✅', '✅'],
  ['✅ 対応', '✅'],
  ['✅（一部）', '✅'],
  ['✅/⏭️ 部分対応', '✅'],
  ['⏭️ 見送り', '⏭️'], // VS16 付き（実データは全件こちら）
  ['⏭ 見送り', '⏭️'], // bare（将来の揺れに備える）
  ['🔁 **既判断**', '🔁'],
  ['❓', '❓'],
  ['❌', '❓'], // 設計語彙外 → ❓ フォールバック
  ['**✅** 強調付き', '✅'], // 先頭の強調記号を strip
  ['対応不要', null], // 既知記号で始まらない → 隔離
  ['—', null],
  ['', null],
  ['→ issue化', null],
];

for (const [input, expected] of NORM_CASES) {
  test(`normalizeJudgment: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizeJudgment(input), expected);
  });
}

// --- disposition_reason 推定（明確なパターンのみ。それ以外は unknown） ---

test('inferDispositionReason: ✅ は valid-fixed、✅一部は unknown（誤断定しない）', () => {
  assert.equal(inferDispositionReason('✅', '✅ 対応', '修正した'), 'valid-fixed');
  assert.equal(inferDispositionReason('✅', '✅（一部）', ''), 'unknown');
});

test('inferDispositionReason: 🔁 は duplicate-already-fixed', () => {
  assert.equal(inferDispositionReason('🔁', '🔁 既判断', 'round2 #3 と同一'), 'duplicate-already-fixed');
});

test('inferDispositionReason: ⏭️ の理由文パターン', () => {
  assert.equal(inferDispositionReason('⏭️', '⏭️', '過剰防御のため不要'), 'over-guard');
  assert.equal(inferDispositionReason('⏭️', '⏭️', '現コールサイトでは到達不能'), 'unreachable-by-current-callsite');
  assert.equal(inferDispositionReason('⏭️', '⏭️', '別issue化して対応する'), 'out-of-scope-follow-up-needed');
  assert.equal(inferDispositionReason('⏭️', '⏭️', 'レビュアーの誤読'), 'reviewer-misread');
  assert.equal(inferDispositionReason('⏭️', '⏭️', '理由の記載なし'), 'unknown');
});

// --- keyword → primary_area の優先順位 ---

test('classifyArea: E2Eテストは広語「テスト」より先に test-e2e に分類される', () => {
  assert.equal(classifyArea('E2Eテストがフレークする', ''), 'test-e2e');
});

test('classifyArea: tiptap 系は最優先', () => {
  assert.equal(classifyArea('Tiptap の hardBreak 処理漏れ', ''), 'tiptap-prosemirror');
});

test('classifyArea: 一致なしは unclassified', () => {
  assert.equal(classifyArea('あいまいな指摘', 'なにか直した'), 'unclassified');
});

test('classifyArea: 領域語が理由セルにだけある項目も分類できる', () => {
  assert.equal(
    classifyArea('位置がずれる', '修正した', 'ProseMirror の position 仕様のため', '✅'),
    'tiptap-prosemirror',
  );
});

// --- buildDetailedItems: 全 judgment 対象化＋隔離＋既存フィールド不変 ---

function makeItem(overrides = {}) {
  return {
    pr: 100,
    date: '2026-07-01',
    round: 1,
    num: '1',
    reviewer: 'Gemini',
    summary: 'Tiptap の hardBreak 処理漏れ',
    judgment: '✅ 対応',
    reason: '',
    response: '修正した',
    category: 'other',
    keywords_matched: [],
    ...overrides,
  };
}

test('buildDetailedItems: ✅/⏭️/🔁 が対象化され、既知記号で始まらない行は隔離される', () => {
  const items = [
    makeItem(),
    makeItem({ judgment: '⏭️ 見送り', reason: '別issue化' }),
    makeItem({ judgment: '🔁 既判断' }),
    makeItem({ judgment: '対応', summary: '非レビュー表の誤パース行', num: '9', round: 2 }),
  ];
  const { detailed, excluded, excludedRows } = buildDetailedItems(items);
  assert.equal(detailed.length, 3);
  assert.equal(excluded, 1);
  assert.deepEqual(excludedRows, ['PR#100 round2 #9']); // 隔離行を監査可能にする識別子
  assert.deepEqual(
    detailed.map((d) => d.judgment_norm),
    ['✅', '⏭️', '🔁'],
  );
});

test('buildDetailedItems: 多軸フィールドのデフォルト値（設計書 §2）と confidence=auto', () => {
  const { detailed } = buildDetailedItems([makeItem()]);
  const d = detailed[0];
  assert.equal(d.primary_area, 'tiptap-prosemirror');
  assert.deepEqual(d.secondary_areas, []);
  assert.deepEqual(d.failure_types, []);
  assert.deepEqual(d.root_causes, []);
  assert.deepEqual(d.risk_cases, []);
  assert.deepEqual(d.preventable_by, []);
  assert.equal(d.implementation_phase_catchable, 'unknown');
  assert.equal(d.lintable, false);
  assert.equal(d.disposition_reason, 'valid-fixed');
  assert.equal(d.confidence, 'auto');
});

test('buildDetailedItems: lintable は legacy category から引き継ぐ', () => {
  const { detailed } = buildDetailedItems([makeItem({ category: 'xss-security' })]);
  assert.equal(detailed[0].lintable, true);
});

test('buildDetailedItems: 元 item オブジェクトを変更しない（items.json byte 互換）', () => {
  const item = makeItem();
  const before = JSON.stringify(item);
  buildDetailedItems([item]);
  assert.equal(JSON.stringify(item), before);
});

// --- buildRiskPatterns: 集計・followup 抽出・プロトタイプ汚染耐性・キー順 ---

test('buildRiskPatterns: 領域別に total / auto_count が集計され followup が抽出される', () => {
  const { detailed } = buildDetailedItems([
    makeItem(),
    makeItem({ judgment: '⏭️', reason: '別issue化が必要', summary: 'Tiptap の position ずれ' }),
  ]);
  const patterns = buildRiskPatterns(detailed);
  const area = patterns['tiptap-prosemirror'];
  assert.equal(area.total, 2);
  assert.equal(area.auto_count, 2);
  assert.equal(area.curated_count, 0);
  assert.equal(area.followups.length, 1);
  assert.equal(area.followups[0].disposition_reason, 'out-of-scope-follow-up-needed');
});

test('buildRiskPatterns: __proto__ を含む summary で汚染されない（INVARIANTS #11）', () => {
  const { detailed } = buildDetailedItems([makeItem({ summary: '__proto__', response: '__proto__' })]);
  detailed[0].primary_area = '__proto__';
  const patterns = buildRiskPatterns(detailed);
  assert.equal({}.total, undefined);
  assert.equal(patterns['__proto__'].total, 1);
});

test('buildRiskPatterns: 領域キーはソート済み（再現可能ビルド）', () => {
  const { detailed } = buildDetailedItems([
    makeItem({ summary: 'zzz', response: '' , category: 'other'}),
    makeItem(),
  ]);
  const keys = Object.keys(buildRiskPatterns(detailed));
  assert.deepEqual(keys, [...keys].sort());
});

// --- renderRiskPatternsMd: 空集計の注記（U1: 「リスクなし」と誤読させない） ---

test('buildRiskPatterns: json 単体消費者向けの _note を含む（空集計=リスクなしと誤読させない）', () => {
  const { detailed } = buildDetailedItems([makeItem()]);
  const patterns = buildRiskPatterns(detailed);
  assert.match(patterns._note, /リスクなしを意味しない/);
});

test('renderRiskPatternsMd: _note キーは領域セクションとして描画されない', () => {
  const { detailed } = buildDetailedItems([makeItem()]);
  const md = renderRiskPatternsMd(buildRiskPatterns(detailed));
  assert.doesNotMatch(md, /## _note/);
});

test('renderRiskPatternsMd: root_causes/risk_cases が空の領域に「リスクなしを意味しない」注記が出る', () => {
  const { detailed } = buildDetailedItems([makeItem()]);
  const md = renderRiskPatternsMd(buildRiskPatterns(detailed));
  assert.match(md, /リスクなしを意味しない/);
  assert.match(md, /auto: 1 \/ curated: 0/);
});

test('renderRiskPatternsMd: 決定的な出力（同一入力で byte 一致・日付を含まない）', () => {
  const { detailed } = buildDetailedItems([makeItem()]);
  const md1 = renderRiskPatternsMd(buildRiskPatterns(detailed));
  const md2 = renderRiskPatternsMd(buildRiskPatterns(detailed));
  assert.equal(md1, md2);
  assert.doesNotMatch(md1, /\d{4}-\d{2}-\d{2}/);
});
