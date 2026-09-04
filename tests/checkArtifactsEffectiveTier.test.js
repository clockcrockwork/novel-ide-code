import test from 'node:test';
import assert from 'node:assert/strict';

import { checkArtifacts } from '../scripts/agent/check-artifacts.js';
import { buildBody } from './helpers/checkArtifactsBody.js';

// 実効 Tier 宣言の機械検査。
// 初期 Tier は PR の変更内容から決まり、実効 Tier は外部レビュー由来の正当な新規所見等で
// 加算された結果を表す。宣言があれば**実効 Tier を必須系統の基準**にし、PR 内での縮小を拒否する。

const LIGHT_ROW = '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |';
const ADDON_ROW = '| 2 | 仕様・ビジネスロジック＋運用性・状態遷移 | 0件 | 収束 |';

function loop(decl, rows) {
  return `${decl}\n\n| 周回 | 系統 | 新規所見 | 対応 |\n|---|---|---|---|\n${rows.join('\n')}`;
}

function run(loopSection, changedFiles = ['src/lib/foo.js']) {
  return checkArtifacts({ changedFiles, body: buildBody({ loop: loopSection }) });
}

test('実効 Tier 宣言なし → 従来どおり初期 Tier が必須系統の基準（後方互換）', () => {
  const { errors } = run(loop('Tier: Light（通常コード変更）', [LIGHT_ROW]));
  assert.deepEqual(errors, []);
});

test('実効 Tier で加算された系統の実施行が無いと落ちる', () => {
  const { errors } = run(
    loop(
      'Tier: Light（通常コード変更）\n実効Tier: Light＋設計文書（外部新規所見: 運用性で実行主体不在）',
      [LIGHT_ROW],
    ),
  );
  assert.ok(
    errors.some((e) => e.includes('仕様・ビジネスロジック') && e.includes('実施行')),
    `加算系統の未実施が検出されていない:\n${errors.join('\n')}`,
  );
  assert.ok(errors.some((e) => e.includes('運用性・状態遷移')));
});

test('実効 Tier で加算された系統を実施・収束していれば通る', () => {
  const { errors } = run(
    loop(
      'Tier: Light（通常コード変更）\n実効Tier: Light＋設計文書（外部新規所見: 運用性で実行主体不在）',
      [LIGHT_ROW, ADDON_ROW],
    ),
  );
  assert.deepEqual(errors, []);
});

test('実効 Tier は初期 Tier の必須系統を縮小できない（fail-closed）', () => {
  const { errors } = run(
    loop('Tier: Light（通常コード変更）\n実効Tier: Docs（軽い変更だったので下げる）', [LIGHT_ROW]),
  );
  assert.ok(
    errors.some((e) => e.includes('縮小') && e.includes('実効 Tier')),
    `縮小が拒否されていない:\n${errors.join('\n')}`,
  );
});

test('実効 Tier 宣言の昇格理由が空・プレースホルダなら落ちる', () => {
  for (const reason of ['', 'TODO', '理由', '―']) {
    const { errors } = run(
      loop(`Tier: Light（通常コード変更）\n実効Tier: Light＋設計文書（${reason}）`, [
        LIGHT_ROW,
        ADDON_ROW,
      ]),
    );
    assert.ok(
      errors.some((e) => e.includes('実効 Tier 宣言の昇格理由')),
      `理由「${reason}」がプレースホルダとして拒否されていない`,
    );
  }
});

test('実効 Tier 宣言が競合したら落ちる', () => {
  const { errors } = run(
    loop(
      'Tier: Light（通常コード変更）\n実効Tier: Light＋設計文書（外部新規所見）\n実効Tier: Full（高影響所見）',
      [LIGHT_ROW, ADDON_ROW],
    ),
  );
  assert.ok(errors.some((e) => e.includes('実効 Tier 宣言が競合')));
});

test('実効 Tier が初期 Tier と同じなら受理しつつ警告する（宣言は省略できる）', () => {
  const { errors, warnings } = run(
    loop('Tier: Light（通常コード変更）\n実効Tier: Light（加算なし）', [LIGHT_ROW]),
  );
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('省略できます')));
});

test('免除宣言（Tier: なし）と実効 Tier 宣言の併存は拒否する', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['docs/agent-workflows/x.md'],
    body: buildBody({
      loop: 'Tier: なし（説明・記録文書: 誤字修正のみ）\n実効Tier: 設計文書（外部新規所見）',
    }),
  });
  assert.ok(
    errors.some((e) => e.includes('免除宣言') && e.includes('実効 Tier')),
    `免除と実効 Tier の併存が拒否されていない:\n${errors.join('\n')}`,
  );
});

test('実効 Tier 宣言は初期 Tier 宣言として誤認されない（競合と誤診断しない）', () => {
  const { errors } = run(
    loop('Tier: Light（通常コード変更）\n実効Tier: Light＋設計文書（外部新規所見）', [
      LIGHT_ROW,
      ADDON_ROW,
    ]),
  );
  assert.ok(!errors.some((e) => e.includes('Tier 宣言が競合')));
});

test('コードフェンス・引用の中の実効 Tier は宣言と数えない（例示の透過を防ぐ）', () => {
  const fenced = [
    'Tier: Light（通常コード変更）',
    '',
    '```markdown',
    '実効Tier: Full（例示）',
    '```',
    '',
    '| 周回 | 系統 | 新規所見 | 対応 |',
    '|---|---|---|---|',
    LIGHT_ROW,
  ].join('\n');
  const { errors } = run(fenced);
  assert.deepEqual(errors, [], `例示の実効 Tier が宣言として拾われている:\n${errors.join('\n')}`);
});

test('docs のみ PR でも実効 Tier で加算できる（縮小はできない）', () => {
  const body = buildBody({
    loop: loop(
      'Tier: Record（記憶レコードの追加）\n実効Tier: 設計文書（外部新規所見: 仕様で完了条件の不整合）',
      [
        '| 1 | 減算＋清掃 | 0件 | 収束 |',
        '| 2 | 仕様・ビジネスロジック＋運用性・状態遷移 | 0件 | 収束 |',
      ],
    ),
  });
  const { errors } = checkArtifacts({
    changedFiles: ['docs/agent-memory/records/a.json'],
    body,
  });
  assert.deepEqual(errors, []);
});
