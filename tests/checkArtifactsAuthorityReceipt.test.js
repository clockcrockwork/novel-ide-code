import test from 'node:test';
import assert from 'node:assert/strict';

import { checkArtifacts } from '../scripts/agent/check-artifacts.js';
import { buildBody, FULL_ARTIFACTS } from './helpers/checkArtifactsBody.js';

// #645: Artifacts Gate の authority routing execution receipt（review-plan.js
// formatAuthorityReceipt() が生成し、check-artifacts.js が検証する閉じた1行文法）の受理・
// 拒否シナリオ。issue #645「Acceptance scenarios」1〜9 に対応する。
//
// 生成側（review-plan.js）の単体テストは tests/reviewPlan.test.js、共有ヘルパー
// （formatAngleList/parseAngleList）は tests/reviewAngleTokens.test.js に置く。ここでは
// check-artifacts.js が「receipt を検証するだけの consumer」であること
// （selectedAngles・escalation overlay・incomplete/error anti-skip を再計算しない）を
// PR 本文レベルの受理・拒否として確認する。

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function receiptLine({
  head = HEAD,
  authority = 'authority',
  selected = '-',
  escalated = '-',
  conditional = '-',
  effective = '-',
  sidecars = '-',
  version = '1',
} = {}) {
  return (
    `Authority receipt: v${version} head=${head} authority=${authority} ` +
    `selected=${selected} escalated=${escalated} conditional=${conditional} ` +
    `effective=${effective} sidecars=${sidecars}`
  );
}

test('#645-1 authority reduction: 有効な receipt が legacy Light の必須集合を差し替え、riskmodel+testquality のみで収束する', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

test('#645-1 authority reduction: legacy Tier だけが要求する減算・敵対的・コード品質・清掃を Gate も要求しない', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  for (const label of ['減算', '敵対的', 'コード品質', '清掃']) {
    assert.ok(!errors.some((e) => e.includes(label)), `${label} を誤って要求している: ${errors}`);
  }
});

test('#645-2 testquality missing: receipt が riskmodel+testquality を要求するが loop に riskmodel しかない → FAIL', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('test-quality') && e.includes('実施行がレビューループ記録にありません')));
});

test('#645-3 manual escalation: escalated=operability が effective に含まれる receipt は operability 行も必須にする', () => {
  const loopOk = `Tier: Light（テスト用コード変更）
${receiptLine({
    selected: 'riskmodel,testquality',
    escalated: 'operability',
    effective: 'riskmodel,testquality,operability',
  })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality＋運用性・状態遷移 | 0件 | 収束 |`;
  const ok = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopOk }),
    headSha: HEAD,
  });
  assert.deepEqual(ok.errors, []);

  const loopMissing = `Tier: Light（テスト用コード変更）
${receiptLine({
    selected: 'riskmodel,testquality',
    escalated: 'operability',
    effective: 'riskmodel,testquality,operability',
  })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const missing = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopMissing }),
    headSha: HEAD,
  });
  assert.ok(missing.errors.some((e) => e.includes('運用性・状態遷移')));
});

test('#645-4 stale receipt: head が現在の PR head と不一致 → authority 縮小として受理せず legacy Tier 必須集合を使う', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ head: OTHER_HEAD, selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('減算')));
  assert.ok(errors.some((e) => e.includes('敵対的')));
});

test('#645 headSha 解決不能(null): receipt を束縛できないため legacy Tier 必須集合を使う', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: null,
  });
  assert.ok(errors.some((e) => e.includes('減算')));
});

test('#645-5 malformed receipt: 閉じた語彙外の angle → fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ effective: 'riskmodel,bogus' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('閉じた語彙外')));
});

test('#645-5 malformed receipt: conditional フィールドも閉じた語彙で検証される（selected/escalated/effective 専用の検証ではない）', () => {
  // conditional は memory の kind を保持するためだけの provenance フィールドで、
  // requiredAngles の pass/fail 判定そのものには使わない（memory row の要否を新たに machine
  // enforce しない — issue #645「memory」節）。だが receipt 全体が閉じた語彙で検証される契約は
  // conditional にも適用されることを、selected/escalated/effective とは独立に確認する
  // （減算レビュー所見: conditional が実際に検証されている証拠がテストに無かった）。
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ conditional: 'bogus-conditional' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('閉じた語彙外') && e.includes('bogus-conditional')));
});

test('#645-5 malformed receipt: prototype-chain key（__proto__）は閉じた語彙外として拒否する', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ effective: '__proto__' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('閉じた語彙外')));
});

test('#645-5 malformed receipt: 不正な authority 値 → fail-loud（「宣言なし」に静かに落ちない）', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ authority: 'bogus' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('authority は authority / fallback')));
});

test('#645-5 malformed receipt: 非対応バージョン → fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ version: '2' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('version が非対応')));
});

test('#645-5 malformed receipt: head が40桁hexでない → fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ head: 'not-a-sha' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('40桁')));
});

test('#645-5 malformed receipt: 競合する2つの宣言 → fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ effective: 'riskmodel' })}
${receiptLine({ effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('競合しています')));
});

test('#645-5 malformed receipt: 書式外（フィールド欠落）は「宣言なし」ではなく fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
Authority receipt: v1 head=${HEAD} authority=authority selected=riskmodel

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('受理文法外')));
});

test('#645-5 malformed receipt: internal invariant 違反（escalated が effective に含まれない）→ fail-loud', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', escalated: 'operability', effective: 'riskmodel' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋運用性・状態遷移 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('internal invariant')));
});

test('#645-6 receipt absent: authority 機構の追加後も legacy Tier のみの PR は無変更で通る', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: FULL_ARTIFACTS,
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

test('#645-7 fallback receipt: authority=fallback は legacy Tier 必須集合を維持する（effective は無視）', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ authority: 'fallback', effective: 'riskmodel' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('減算')));
});

test('#645-8 incomplete/error retained angle: raw selected から外れても effective に残る angle は必須のまま', () => {
  const loopOk = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const ok = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopOk }),
    headSha: HEAD,
  });
  assert.deepEqual(ok.errors, []);

  const loopMissing = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const missing = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopMissing }),
    headSha: HEAD,
  });
  assert.ok(missing.errors.some((e) => e.includes('test-quality')));
});

test('#645-9 authority reviewer 0件（forged）: コード変更で effective/sidecars 空集合の receipt は forged 縮小として拒否し legacy Tier を使う', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: '-', effective: '-', sidecars: '-' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`;
  // legacy Light の必須系統をすべて実施した記録があるため、receipt の空集合が拒否され
  // legacy 必須系統が使われていること（さもなくば無条件で pass するはず）を裏から確認する
  const passing = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(passing.errors, []);

  const loopNoRecord = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: '-', effective: '-', sidecars: '-' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | (なし) | 0件 | 収束 |`;
  const failing = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopNoRecord }),
    headSha: HEAD,
  });
  assert.ok(failing.errors.some((e) => e.includes('減算')));
});

// risk-model 検証所見（実行確認済み）: 空集合floorの発火条件が `effective.length === 0 &&
// sidecars.length === 0 && codeChanged` だった旧実装では、`sidecars` に何か1つでも値
// （例: `/security-review`）を入れるだけで floor が不発火になり、コード変更を伴う diff でも
// 通常系統ゼロ件の receipt が forged 縮小として拒否されずに通ってしまっていた
// （`sidecars` は machine-tracked obligation ではないため、それ単体を通常 angle 側の義務を
// 免除する根拠にしてはならない）。floor の判定条件から `sidecars` を除外して修正した。
test('#645-9 authority reviewer 0件（forged・sidecars迂回）: sidecarsに値を入れてもfloorを回避できない', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: '-', effective: '-', sidecars: '/security-review' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | (なし) | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(
    errors.some((e) => e.includes('減算')),
    'sidecars を非空にするだけで空集合floorを回避できてはならない',
  );
});

test('#645-9 authority reviewer 0件（legitimate）: docs-only diff では正当な空集合 receipt を受理する（cleanup すら要求しない）', () => {
  const loop = `Tier: Docs（テスト用説明文書変更）
${receiptLine({ selected: '-', effective: '-', sidecars: '-' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | (なし) | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['docs/history.md'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 仕様レビュー所見 S-3: receipt を採用する場合、legacy 専用の「実効Tier:」宣言（widen-only の
// 手動加算）は必須系統の算出に一切使われなくなる。無警告のまま黙って無視すると、著者が
// 「実効Tier で加算したのに実際にはレビューされていない」ことに気づけないため、warning を出す。
// 敵対的レビュー所見 ADV-1（blocker 級）: 当初実装は receipt 採用時に「実効Tier:」宣言
// （legacy 専用の widen-only 手動加算。旧実装唯一の fail-closed anti-shrink 不変条件）を
// 完全に無視し、warning を出すだけで exit 0 していた。修正後は「実効Tier:」宣言があれば
// その必須系統を receipt の effective との**和集合**として要求する（実効Tier は縮小されない）。
test('#645 実効Tier宣言との相互作用（ADV-1修正）: 実効Tier宣言はreceiptがあっても縮小されない（和集合で要求）', () => {
  const loopMissing = `Tier: Light（テスト用コード変更）
実効Tier: Full（外部レビューで敵対的の新規所見が出たため加算）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const missing = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopMissing }),
    headSha: HEAD,
  });
  // 実効Tier: Full は7系統を要求する。receipt の riskmodel+testquality だけでは
  // 敵対的・減算・仕様・コード品質・運用性・清掃が欠落するため FAIL するはず
  assert.ok(missing.errors.some((e) => e.includes('敵対的')));
  assert.ok(missing.warnings.some((w) => w.includes('実効Tier') && w.includes('和集合')));

  const loopSatisfied = `Tier: Light（テスト用コード変更）
実効Tier: Full（外部レビューで敵対的の新規所見が出たため加算）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋仕様・ビジネスロジック＋敵対的＋risk-model 検証＋test-quality＋コード品質＋運用性・状態遷移＋清掃 | 0件 | 収束 |`;
  const satisfied = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop: loopSatisfied }),
    headSha: HEAD,
  });
  assert.deepEqual(satisfied.errors, []);
});

// 敵対的レビュー2周目所見 ADV2-1: 「実効Tier:」の書式が壊れている（値をインラインコードで
// 囲む等）と EFFECTIVE_TIER_DECL に一致せず「宣言なし」に落ちるため、和集合フロアが無警告で
// 不発火になり、人間には「Full へ加算済み」と読める本文のまま receipt の縮小がそのまま通って
// しまっていた。receipt 採用時は「実効Tier」の緩い出現判定で書式外を検出し fail-loud にする。
test('#645 実効Tier宣言の書式外（ADV2-1修正）: 値をインラインコードで囲むと「宣言なし」ではなく fail-loud になる', () => {
  const loop = `Tier: Light（テスト用コード変更）
実効Tier: \`Full\`（外部レビューで敵対的の新規所見が出たため加算）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('実効Tier') && e.includes('受理文法')));
});

// EFFECTIVE_TIER_MENTION は既存の TIER_MENTION と同じ行頭アンカー（`(?:^|\n)[ \t]*`。半角空白・
// タブのみ許容）を踏襲する（ADV3-1 の派生確認: アンカーを外すと地の文中の言及まで誤検出する）。
// そのため全角空白の前置は、legacy Tier: 宣言自体の TIER_MENTION と同じく「行頭」とは
// 認識されず、書式外検出には掛からない（宣言なし＝receiptがそのまま有効という既存の残存
// 制約。Tier: 宣言側と同じ限界であり本 PR で新たに悪化させるものではない）。
test('#645 実効Tier宣言の書式外（ADV2-1修正）: 全角空白の前置は legacy Tier: 宣言と同じく検出対象外（既知の残存制約）', () => {
  const loop = `Tier: Light（テスト用コード変更）
　実効Tier: Full（外部レビューで敵対的の新規所見が出たため加算）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 敵対的レビュー3周目所見 ADV3-1: ADV2-1 の緩い出現判定を「ループセクションの生ソース全体」に
// かけると、表セル・コードフェンス・引用・打ち消し線・対応セルの地の文中の「実効Tier」言及まで
// 「書式外宣言」として誤って fail-loud にしてしまっていた。判定は Tier: 宣言と同じ境界
// （段落のみ・コードフェンス/インラインコード/引用/表セル/打ち消し線を除外）に揃えて修正した。
test('#645 実効Tier宣言の書式外（ADV3-1修正）: 表セル・引用・打ち消し線・対応セルの地の文中の言及は誤検知しない', () => {
  const cases = [
    // 表の外（周回セル外の地の文）での言及（宣言ではなく説明）
    `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

補足: 実効Tier: 加算なし（今回は不要と判断）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`,
    // 引用
    `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

> 実効Tier: Full（過去の引用例）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`,
    // 打ち消し線（撤回済み）
    `Tier: Light（テスト用コード変更）
~~実効Tier: Full（撤回済み）~~
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`,
  ];
  for (const loop of cases) {
    const { errors } = checkArtifacts({
      changedFiles: ['src/lib/foo.js'],
      body: buildBody({ loop }),
      headSha: HEAD,
    });
    assert.deepEqual(errors, [], `誤検知した本文: ${loop}`);
  }
});

test('#645 実効Tier宣言の書式外: receiptを採用しない場合（fallback/stale）はこの追加検証を行わない（legacy専用の実効Tier挙動は不変）', () => {
  const loop = `Tier: Light（テスト用コード変更）
実効Tier: \`Full\`（外部レビューで敵対的の新規所見が出たため加算）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  // receipt が無いため legacy Tier のみで判定する。壊れた実効Tier記述があっても
  // 従来どおり「宣言なし」（初期Tierがそのまま必須集合）として扱われ、fail-loud にはならない
  assert.deepEqual(errors, []);
});

test('#645 実効Tier宣言なし: receiptのみの場合は従来どおり和集合を作らず receipt.effective のみで判定する', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors, warnings } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => w.includes('実効Tier')));
});

test('#645-10 docs-only regression: receipt が無い設計文書/Record/Docs Tier は従来どおり動く', () => {
  const loop = `Tier: Docs（テスト用説明文書変更）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['docs/history.md'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 外部レビュー（Codex）指摘: 有効な receipt が1件でもあれば、同じセクション内に併存する
// 別の・書式が壊れた（フィールド欠落等）Authority receipt 行が検証されずに無視されていた
// （更新途中で古い縮小 receipt を消し忘れたまま新しい行を追記した場合、新しい行が壊れていても
// 古い行だけが採用されて exit 0 になる）。ラベルの出現数と構文一致数の食い違いを fail-loud にする。
test('#645 malformed receipt（Codex指摘）: 有効なreceiptと併存する書式が壊れたAuthority receipt行はfail-loudになる', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ effective: 'riskmodel' })}
Authority receipt: v1 head=${HEAD} authority=authority selected=riskmodel

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋減算＋敵対的＋コード品質＋清掃 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('受理文法外')));
});

// 外部レビュー（Codex）指摘: 箇条書き（`- 実効Tier: Full（…）`）の実効Tier宣言は
// findEffectiveTierDecls にも段落限定の EFFECTIVE_TIER_MENTION にも掛からず「宣言なし」に
// 静かに落ち、和集合フロアが不発火のまま receipt の縮小だけが通っていた。
// Tier: 宣言側の TIER_MENTION_BROAD と同じ非段落文脈（箇条書き・見出し）の broad 検出を
// 実効Tier側にも適用し、fail-loud にする。
test('#645 実効Tier宣言の書式外（Codex指摘）: 箇条書きの実効Tier宣言もfail-loudになる', () => {
  const loop = `Tier: Light（テスト用コード変更）
- 実効Tier: Full（外部レビューで敵対的の新規所見が出たため加算）

${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('実効Tier') && e.includes('受理文法')));
});

// 外部レビュー（Codex）続報: 箇条書き broad 検出（hasBroadMention）が打ち消し線（delete）・
// 引用（blockquote）の中の文字列まで拾ってしまい、撤回済みの宣言や第三者の引用が
// 「本物の宣言意図あり」と誤検出されていた。誤検出されると findEffectiveTierDecls には
// 掛からない（段落限定のため）ので effectiveTierMentioned だけが true になり、
// 実際には宣言していないのに「実効Tier宣言が書式外」の fail-loud エラーになってしまう
// （偽陽性: 正当な PR を通せなくする方向のバグ）。
test('#645 実効Tier宣言の打ち消し線（Codex指摘）: 取り消し済みの実効Tier宣言はmentionと誤検出されない', () => {
  const loop = `Tier: Light（テスト用コード変更）
- ~~実効Tier: Full（撤回済み）~~

${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

test('#645 実効Tier宣言の引用（Codex指摘）: 引用内の実効Tier宣言はmentionと誤検出されない', () => {
  const loop = `Tier: Light（テスト用コード変更）
> - 実効Tier: Full（引用であり自分の宣言ではない）

${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 外部レビュー（Codex）続報: `!effectiveTierDeclared` でのゲートは「有効な宣言が1件も無い」
// 場合しか検出しない。有効な実効Tier宣言（Light）を残したまま、書式が壊れた実効Tier宣言
// （`Full` をインラインコードで囲んでいて貼り付けに失敗した）を追記すると、
// effectiveTierDeclared は true のままこの分岐自体に入らず、壊れた行が無視されたまま
// 古い宣言だけが採用されてしまっていた。
test('#645 実効Tier宣言の併存する壊れた宣言（Codex続報）: 有効な実効Tier宣言があっても別の壊れた宣言はfail-loudになる', () => {
  const loop = `Tier: Light（テスト用コード変更）
実効Tier: Light（初期のまま加算なし）
実効Tier: \`Full\`（外部レビューで敵対的の新規所見が出たため加算・貼り付け失敗）
${receiptLine({ selected: 'riskmodel,testquality', effective: 'riskmodel,testquality' })}

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証＋test-quality | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('実効Tier') && e.includes('受理文法')));
});

// 外部レビュー（Codex）続報: Authority receipt の mentionCount は loopDeclRuns（段落のみ）上
// でしか数えていなかったため、箇条書き・見出しとして書かれた壊れた receipt は mentionCount にも
// matches にも現れず、併存する有効な receipt だけが採用されて exit 0 になってしまっていた。
test('#645 Authority receiptの箇条書き併存（Codex続報）: 有効なreceiptがあっても箇条書きの壊れたreceiptはfail-loudになる', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel' })}

- Authority receipt: v1 head=${HEAD} authority=authority selected=riskmodel

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('受理文法外')));
});

// 外部レビュー（Codex）続報: フィールド区切りに `\s+` を使うと改行も許容してしまい、
// 物理的に複数行へ分割された「Authority receipt: ...」も閉じた1行文法として受理されていた。
test('#645 Authority receiptの複数行分割（Codex続報）: 改行で分割されたreceiptはfail-loudになる（宣言なしにならない）', () => {
  const loop = `Tier: Light（テスト用コード変更）
Authority receipt: v1
head=${HEAD} authority=authority selected=riskmodel escalated=- conditional=- effective=riskmodel sidecars=-

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.ok(errors.some((e) => e.includes('受理文法外')));
});

// 外部レビュー（Codex）続報: countBroadMentions の collect() は除外ノード（inlineCode 等）を
// 除去するだけで境界マーカーへ置換していなかったため、`Authority` + inlineCode + `receipt:` の
// ような単なる説明文が「Authority receipt:」に偽装連結され、有効な receipt が1件しか無くても
// mentionCount が水増しされて fail-loud（受理文法外）になる偽陽性があった
// （loopDeclRuns が RUN_MARKER で同じクラスの偽装を防いでいるのと同じ境界を揃える）。
test('#645 Authority receiptの偽装連結（Codex続報）: 除外ノード除去による偽陽性mentionは発生しない', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel' })}

- Authority\`routing\` receipt: 説明のみで宣言ではない

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 外部レビュー（Codex）続報: 前回の inline-code 除外ノード修正後も、画像・空リンクのように
// `value` も子テキストも持たない leaf node（image・imageReference・break・thematicBreak 等）は
// 除外リストに入っていないため何も追加せず消え、前後の無関係な地の文が同様に偽装連結されて
// しまっていた。除外型リストの列挙ではなく「テキストも子も持たないノードは無条件にマーカー」
// という否定的判定に統一して塞いだ。
test('#645 Authority receiptの画像偽装連結（Codex続報）: テキストも子も持たないleaf nodeもRUN_MARKERに置換される', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel' })}

- Authority ![](x)receipt: 説明のみで宣言ではない

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});

// 外部レビュー（Codex）続報: 上記の leaf-node 修正は countBroadMentions()（箇条書き・見出し
// 経路）にしか適用されておらず、findAuthorityReceipts() が直接使う loopDeclRuns()（段落経路）
// 側には同じ穴が残っていた。段落内で有効な receipt と併記した「Authority + 画像 + receipt:」の
// ような説明文も、画像ノードが除去されて偽装連結され、正当な PR が受理文法外になっていた。
// loopDeclRuns() 側にも同じ「テキストも子も持たないノードは無条件にマーカー」判定を適用した。
test('#645 Authority receiptの段落内画像偽装連結（loopDeclRuns・Codex続報）: 直接段落でも偽陽性mentionは発生しない', () => {
  const loop = `Tier: Light（テスト用コード変更）
${receiptLine({ selected: 'riskmodel', effective: 'riskmodel' })}

Authority ![](x)receipt: 説明のみで宣言ではない

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: buildBody({ loop }),
    headSha: HEAD,
  });
  assert.deepEqual(errors, []);
});
