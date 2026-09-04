import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { rmSync } from 'node:fs';

import { checkArtifacts, classify } from '../scripts/agent/check-artifacts.js';
import { parseBody, findSection, sectionSourceLines } from '../scripts/agent/mdast-body.js';
import { FULL_ARTIFACTS, buildBody, withEvidence } from './helpers/checkArtifactsBody.js';
import { makeTmpGitRepo, sh } from './helpers/tmpGitRepo.js';

const CHECK_ARTIFACTS_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/agent/check-artifacts.js',
);

// 敵対的スイープ（正負ペアの網羅: 証拠ポインタ / 区切り記法 / 関連 issue / 収束宣言）は
// tests/checkArtifactsSweep.test.js の表駆動ハーネスに集約した（issue #401）。
// このファイルには表駆動になじまない単発シナリオ（分類・セクション検出・テーブル選択の
// 構造判定・ReDoS 耐性など）を残す。

test('コード変更 + 全 artifact 揃い → エラーなし', () => {
  const { errors, mandated } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: FULL_ARTIFACTS,
  });
  assert.equal(mandated, true);
  assert.deepEqual(errors, []);
});

test('コード変更なのに artifact 未作成 → 5 セクション欠落＋関連 issue なしを検出', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['src/lib/foo.js'],
    body: '## 変更の概要\n実装した。',
  });
  assert.equal(errors.length, 6);
  assert.ok(errors.some((e) => e.includes('完了条件')));
  assert.ok(errors.some((e) => e.includes('既存実装調査')));
  assert.ok(errors.some((e) => e.includes('想定ケース')));
  assert.ok(errors.some((e) => e.includes('証拠表')));
  assert.ok(errors.some((e) => e.includes('レビューループ記録')));
  assert.ok(errors.some((e) => e.includes('関連 issue')));
});

test('必須セクションがプレースホルダ/コメントのみ → 空として検出', () => {
  const body = `
## 完了条件
<!-- ここに書く -->

## 想定ケース
...

## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | a | ✅ |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了条件') && e.includes('空')));
  assert.ok(errors.some((e) => e.includes('想定ケース') && e.includes('空')));
});

test('証拠表: ✅ 判定なのに証拠セルが空 → 検出', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 |  | ✅ |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了主張の行に証拠がありません')));
});

test('証拠表: ✅ 判定で証拠が N/A（skip 語）→ 検出', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | N/A | ✅ |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了主張の行に証拠がありません')));
});

test('証拠表: 判定が「OK」（✅以外）でも証拠なしを検出', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 |  | OK |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了主張の行に証拠がありません')));
});

test('証拠表: 判定が「完了」で証拠が「確認済み」（skip 語）→ 検出', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | 確認済み | 完了 |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了主張の行に証拠がありません')));
});

test('証拠表: 判定が未着手（⬜）は証拠なしでもエラーにならない', () => {
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 |  | ⬜ |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('classify: package.json 単体（lockfile 変更なし）は依存のみとみなさず artifact 必須', () => {
  const { depOnly, codeChanged } = classify(['package.json']);
  assert.equal(codeChanged, true);
  assert.equal(depOnly, false);
});

test('package.json のみ（scripts変更等、lockfileなし）の変更 → artifact 必須のまま', () => {
  const { errors, mandated } = checkArtifacts({
    changedFiles: ['package.json'],
    body: '## 変更の概要\nscripts 追加',
  });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('完了条件')));
});

test('package.json + package-lock.json（lockfile 変更あり）は依存のみとみなす', () => {
  const { depOnly } = classify(['package.json', 'package-lock.json']);
  assert.equal(depOnly, true);
});

test('既存実装調査セクションが欠落 → 検出', () => {
  const body = withEvidence('- [x] lint 実行 — npm run lint の出力: OK').replace(
    /## 既存実装調査\n- Grep "x" src\/ → なし（新規）\n\n/,
    '',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('既存実装調査'));
});

test('既存実装調査セクションが空テーブル（テンプレ）のみ → 空として検出', () => {
  const body = withEvidence('- [x] lint 実行 — npm run lint の出力: OK').replace(
    '- Grep "x" src/ → なし（新規）',
    `| # | 目的 | 検索クエリ / 参照先 | 結果 | 判断 | 理由 |
|---|---|---|---|---|---|`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('既存実装調査') && e.includes('空')));
});

test('必須セクションが HTML コメントのテンプレ記入例のみ（create-pr.md のまま）→ 全て空として検出', () => {
  const body = `
## 完了条件
<!-- requirement-probe の完了条件チェックリストを転記。検証方法付き -->

## 想定ケース
<!-- risk-modeling の想定ケース表。対応する/しない＋理由 -->

## 既存実装調査
<!-- codebase-recon の調査表。実行した検索クエリ・ヒット・再利用/準拠/新規の判断＋理由 -->

## 証拠表
<!-- evidence-check: 完了主張と証拠の表 -->
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了条件') && e.includes('空')));
  assert.ok(errors.some((e) => e.includes('想定ケース') && e.includes('空')));
  assert.ok(errors.some((e) => e.includes('既存実装調査') && e.includes('空')));
  assert.ok(errors.some((e) => e.includes('証拠表') && e.includes('空')));
});

test('丸括弧のみの1行記述（例: （影響なし））は実データとして扱い偽陽性を出さない', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
（影響なし）
## 既存実装調査
（新規作成）
## 証拠表
- [x] test — npm run test → 576 pass
## レビューループ記録
Tier: Light（テスト用最小例）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |

refs #1
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('サブ見出し（H3）を必須セクションとして誤採用しない（例: ### 証拠表の注意点）', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 既存実装調査
### 証拠表の注意点
証拠は file:line 形式で書く。
| # | 目的 | 検索 | 結果 | 判断 | 理由 |
|---|---|---|---|---|---|
| 1 | 類似 | grep | なし | 新規 | 該当なし |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('証拠表') && !e.includes('空')));
});

test('「証拠表」以外の見出し（例: 既存実装調査配下の「新規作成の証拠」）を証拠表として誤認識しない', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 既存実装調査
| # | 目的 | 検索 | 結果 | 判断 | 理由 |
|---|---|---|---|---|---|
| 1 | 類似 | grep foo | なし | 新規 | 該当なし |
### 新規作成の証拠
foo.js は既存に無いことを確認した（検索#1）。
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('証拠表') && !e.includes('空')));
});

test('「既存実装調査」以外の見出し（例: 既存実装への影響）は必須セクションとして誤認識しない', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 既存実装への影響
本PRの変更は foo.js に影響する。既存の呼び出し側は3箇所ある。
## 証拠表
- [x] test — npm run test → 573 pass
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('既存実装調査') && !e.includes('空')));
});

test('Phase2: docs のみの変更（設計文書・記憶レコード以外）→ Docs mandate。レビューループ記録なしはエラー', () => {
  // CLAUDE.md 等の実行可能設計文書は #452 で design mandate、docs/agent-memory/records/ は
  // Phase 2 で record mandate になる。それ以外の prose のみは Docs mandate（清掃レビューのみ必須）
  const { errors, mandated, mandate } = checkArtifacts({
    changedFiles: ['docs/foo.md', 'README.md', 'docs/pr/PR-1.md'],
    body: '## 変更の概要\ndocs 修正',
  });
  assert.equal(mandated, true);
  assert.equal(mandate, 'docs');
  assert.ok(errors.some((e) => e.includes('レビューループ記録') && e.includes('必須')));
});

test('Phase2/外部レビュー対応: LICENSE・.gitignore のみの変更は Docs mandate をトリガーしない（#539 Codex 指摘）', () => {
  // LICENSE/.gitignore は PROSE_PATTERNS に含まれる（codeChanged にはしない）が、
  // 「説明・履歴文書」ではないため Docs mandate（清掃レビュー必須化）の対象にはならない
  const { errors, mandated, mandate } = checkArtifacts({
    changedFiles: ['LICENSE', '.gitignore'],
    body: 'ライセンス年を更新',
  });
  assert.equal(mandated, false);
  assert.equal(mandate, 'none');
  assert.deepEqual(errors, []);
});

test('Phase2: docs のみの変更は Tier: なし（説明・記録文書: 理由）の1行免除で受理できる', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['docs/foo.md', 'README.md', 'docs/pr/PR-1.md'],
    body: '## 変更の概要\ndocs 修正\n\n## レビューループ記録\nTier: なし（説明・記録文書: typo 修正のみ）\n',
  });
  assert.deepEqual(errors, []);
});

test('Phase2: docs のみの変更で Tier: Docs（減算＋清掃）宣言＋収束で受理', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['docs/foo.md', 'README.md', 'docs/pr/PR-1.md'],
    body: `## 変更の概要
docs 修正

## レビューループ記録
Tier: Docs（説明文書の整理）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 清掃 | 0件 | 収束 |
`,
  });
  assert.deepEqual(errors, []);
});

test('Phase2: docs/agent-memory/records/ 配下のみの変更 → Record mandate（減算＋清掃が必須）', () => {
  const { errors, mandate } = checkArtifacts({
    changedFiles: ['docs/agent-memory/records/mem-x.json'],
    body: `## 変更の概要
記憶レコードの追加

## レビューループ記録
Tier: Record（新規決定の記録）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋清掃 | 0件 | 収束 |
`,
  });
  assert.equal(mandate, 'record');
  assert.deepEqual(errors, []);
});

test('Phase2: Record mandate で必須系統（減算）の実施行が無い → エラー', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['docs/agent-memory/records/mem-x.json'],
    body: `## 変更の概要
記憶レコードの追加

## レビューループ記録
Tier: Record（新規決定の記録）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 清掃 | 0件 | 収束 |
`,
  });
  assert.ok(errors.some((e) => e.includes('必須の系統') && e.includes('減算')));
});

test('依存 manifest のみ（Dependabot）→ artifact 必須化しない', () => {
  const { errors, mandated, warnings } = checkArtifacts({
    changedFiles: ['package.json', 'package-lock.json'],
    body: 'chore(deps): bump',
  });
  assert.equal(mandated, false);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('依存 manifest')));
});

test('skip マーカー（理由あり）→ 必須化を免除しエラーなし', () => {
  const { errors, warnings } = checkArtifacts({
    changedFiles: ['src/a.js'],
    body: '実装\n<!-- artifacts-check: skip (緊急 hotfix、追跡は #999) -->',
  });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('スキップ')));
});

test('skip マーカー（理由なし）→ エラー', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['src/a.js'],
    body: '実装\n<!-- artifacts-check: skip -->',
  });
  assert.ok(errors.some((e) => e.includes('理由がありません')));
});

test('.github/workflows 変更はコード扱い（artifact 必須）', () => {
  const { mandated } = checkArtifacts({
    changedFiles: ['.github/workflows/ci.yml'],
    body: '',
  });
  assert.equal(mandated, true);
});

test('証拠表が空テーブル（テンプレ）のみ → 非空要件で検出', () => {
  const body = `
## 完了条件
- [ ] X — 検証: test
## 想定ケース
- 異常系
## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
|  |  |  |
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('証拠表') && e.includes('空')));
});

test('classify: コード＋依存 manifest 混在 → code / deps とも true', () => {
  const { codeChanged, depsChanged, depOnly } = classify([
    'src/lib/foo.js',
    'package.json',
    'docs/a.md',
  ]);
  assert.equal(codeChanged, true);
  assert.equal(depsChanged, true);
  assert.equal(depOnly, false);
});

test('classify: docs のみ → code / deps とも false', () => {
  const { codeChanged, depsChanged } = classify(['docs/a.md', 'CLAUDE.md', '.claude/agents/x.md']);
  assert.equal(codeChanged, false);
  assert.equal(depsChanged, false);
});

test('classify: worker の依存 manifest も deps として検出', () => {
  const { depsChanged, depOnly } = classify(['worker/package.json', 'worker/package-lock.json']);
  assert.equal(depsChanged, true);
  assert.equal(depOnly, true);
});

test('classify: 既知ワークスペース外（bundled action の dist 配下等）の package.json は depOnly にしない → mandate full（#446 round8 敵対的N2r）', () => {
  const { mandated, mandate } = checkArtifacts({
    changedFiles: ['.github/actions/artifacts-gate/dist/package.json', 'package-lock.json'],
    body: '## 変更の概要\n更新',
  });
  assert.equal(mandate, 'full');
  assert.equal(mandated, true);
});

test('classify: worker ワークスペース直下の依存バンプは mandate none（#446 round8 敵対的N2r 回帰確認）', () => {
  const { mandated, mandate } = checkArtifacts({
    changedFiles: ['worker/package.json', 'worker/package-lock.json'],
    body: '',
  });
  assert.equal(mandate, 'none');
  assert.equal(mandated, false);
});

// --- 関連 issue 参照 ---

test('関連 issue: docs のみの PR（Docs mandate）では要求しない', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['docs/a.md'],
    body: `## 変更の概要
docs 修正

## レビューループ記録
Tier: Docs（説明文書の整理）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 清掃 | 0件 | 収束 |
`,
  });
  assert.deepEqual(errors, []);
});

// --- レビューループ記録 ---

test('レビューループ記録: テンプレの HTML コメント内「収束」「残所見」は宣言として扱わない', () => {
  // コメントは表の前（テンプレと同じ位置）に置く。コメント内の「収束」「残所見」を宣言として
  // 拾わず、実データ行（未収束）で正しく落ちることを確認する
  const body = FULL_ARTIFACTS.replace(
    '## レビューループ記録\n',
    '## レビューループ記録\n<!-- 最終行に収束宣言（「収束」を単独セルで。上限超過時は「残所見」を列挙） -->\n',
  ).replace(
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 4件 | 全修正 |',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('収束宣言がありません')));
});

test('レビューループ記録: テーブル直後の refs 行を最終行と誤認しない（テーブルの最終行を正しく判定）', () => {
  // FULL_ARTIFACTS はテーブルの直後に空行＋「refs #1」が続く。この後続テキストではなく
  // テーブル最終行の「収束」を正しく判定対象にする
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: FULL_ARTIFACTS });
  assert.deepEqual(errors, []);
});

test('証拠表: HTML コメント内の証拠なしチェック項目は誤検出しない（コメント除去の全判定への適用）', () => {
  const body = withEvidence(
    '<!-- 例: - [x] ビルド成功 — N/A -->\n- [x] 実際の実行 — tests/x.test.js で確認',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('証拠表: エスケープ済みパイプ（\\|）を含む証拠セルが分割されず偽陽性にならない', () => {
  // 旧実装では \| でもセルが分割され、証拠セルが「確認済み: cat a \」に切り詰められて
  // ポインタなし判定→偽陽性エラーになっていた
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | 確認済み: cat a \\| grep b > src/out.log | ✅ |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('証拠ポインタ: ReDoS 耐性 — 65KB の敵対的入力でも線形時間で完了する', () => {
  const n = 65536;
  const adversarial = [
    'node ' + '--'.repeat(n / 2) + ' x',
    'a/' + '.'.repeat(n) + ' x',
    'x'.repeat(n),
  ];
  for (const evil of adversarial) {
    const start = Date.now();
    const body = withEvidence(`- [x] 実行 — 確認済み ${evil}`);
    checkArtifacts({ changedFiles: ['src/a.js'], body });
    const ms = Date.now() - start;
    assert.ok(ms < 2000, `敵対的入力で ${ms}ms かかった（2秒未満であるべき）`);
  }
});

test('構文解析: 資源上限 — 行数過多・引用ネスト過多の敵対的入力は解析前に fail-loud（#403）', () => {
  // micromark は行指向構造（テーブル行等）で二次時間になる（65KB 未満で ~3s、実測）。
  // テーブル行は先頭パイプなし・blockquote 内・単一列表の平文吸収などパイプを含まない形が
  // あるため、総行数で一様に上限を掛ける。引用ネストは1行で成立するため独立に上限を掛ける
  const adversarial = [
    [
      '標準テーブル行過多',
      '| 周回 | 新規所見 | 対応 |\n|---|---|---|\n' + '| 1 | 0件 | 収束 |\n'.repeat(3200),
      '行数が多すぎます',
    ],
    ['先頭パイプなしテーブル行過多', 'a | b\n--|--\n' + 'x | y\n'.repeat(5000), '行数が多すぎます'],
    [
      'blockquote 内テーブル行過多',
      '> | a | b |\n> |---|---|\n' + '> | x | y |\n'.repeat(4000),
      '行数が多すぎます',
    ],
    ['単一列表の平文行吸収', '| a |\n| - |\n' + 'b\n'.repeat(10000), '行数が多すぎます'],
    ['引用ネスト過多', '>'.repeat(30000) + ' a', 'ネストが深すぎます'],
  ];
  for (const [name, evil, expected] of adversarial) {
    const start = Date.now();
    const { errors } = checkArtifacts({
      changedFiles: ['src/a.js'],
      body: `${FULL_ARTIFACTS}\n${evil}`.slice(0, 65536),
    });
    const ms = Date.now() - start;
    assert.ok(ms < 2000, `${name}: ${ms}ms かかった（2秒未満であるべき）`);
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${name}: 資源ガードが発動しなかった: ${JSON.stringify(errors)}`,
    );
  }
});

test('構文解析: 資源上限内の正常な本文（400 行のループ表・フェンス内のテーブル例示）はガードに掛からない（#403）', () => {
  // 上限内の大きめ本文＋コードフェンス内のテーブル例示（描画されない）がガードエラーにならないこと
  const body =
    FULL_ARTIFACTS.replace(
      '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
      '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |\n'.repeat(399) +
        '| 400 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    ) +
    '\n```\n' +
    '| 例示 | 表 |\n'.repeat(600) +
    '```\n';
  const start = Date.now();
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  const ms = Date.now() - start;
  assert.ok(ms < 2000, `上限内の大きめ本文で ${ms}ms かかった`);
  assert.deepEqual(errors, []);
});

for (const [label, changedFiles, expectedMandate] of [
  ['Docs mandate', ['docs/a.md'], 'docs'],
  ['Record mandate', ['docs/agent-memory/records/x.json'], 'record'],
  ['Design mandate', ['CLAUDE.md'], 'design'],
]) {
  test(`構文解析: 資源上限超過は ${label} でも fail-loud にする（#403・敵対的レビュー Finding A 対応）`, () => {
    // HTML コメント内に隠しても行数・引用ネスト深度は生テキストに対してカウントされる。
    // ここを警告止まりにすると、必須セクション（Tier宣言＋レビューループ記録）の検査自体を
    // 早期 return でスキップして exit 0 になる回避経路が成立してしまうため、mandated は
    // すべて fail-loud（errors）にする
    const body = `${label} 用の巨大な本文\n` + '| a | b |\n'.repeat(2500);
    const { errors, warnings, mandated, mandate } = checkArtifacts({ changedFiles, body });
    assert.equal(mandated, true);
    assert.equal(mandate, expectedMandate);
    assert.ok(
      errors.some((e) => e.includes('行数が多すぎます')),
      `資源ガードが fail-loud にならなかった: ${JSON.stringify({ errors, warnings })}`,
    );
  });

  test(`構文解析: HTML コメント内に本文を隠した資源上限超過も ${label} で検出する（敵対的レビュー Finding A）`, () => {
    const hidden = '<!--\n' + '空行パディング\n'.repeat(2005) + '-->\n';
    const body = `${label} 用の短い可視本文\n${hidden}`;
    const { errors, mandated, mandate } = checkArtifacts({ changedFiles, body });
    assert.equal(mandated, true);
    assert.equal(mandate, expectedMandate);
    assert.ok(
      errors.some((e) => e.includes('行数が多すぎます')),
      `HTML コメント内隠蔽で資源ガードを回避できてしまった: ${JSON.stringify(errors)}`,
    );
  });
}

test('構文解析: 先頭 BOM（U+FEFF）付き本文でも見出し検出が壊れない（#403 risk-modeling）', () => {
  const { errors } = checkArtifacts({
    changedFiles: ['src/a.js'],
    body: '\uFEFF' + FULL_ARTIFACTS,
  });
  assert.deepEqual(errors, []);
});

test('レビューループ記録: ゼロ幅文字（U+200B）混入の「収束」「0件」は文法外として拒否する（#403 risk-modeling）', () => {
  // 不可視文字は受理集合（閉じた文法）の外 → 偽装は原理的に不成立・正当な入力は本文修正で回避
  const zw = '\u200B';
  const struck = FULL_ARTIFACTS.replace(
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収${zw}束 |`,
  );
  const { errors: e1 } = checkArtifacts({ changedFiles: ['src/a.js'], body: struck });
  assert.ok(
    e1.some((e) => e.includes('収束宣言')),
    `ゼロ幅入り収束が通った: ${JSON.stringify(e1)}`,
  );
  const padded = FULL_ARTIFACTS.replace(
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 10${zw}件 | 収束 |`,
  );
  const { errors: e2 } = checkArtifacts({ changedFiles: ['src/a.js'], body: padded });
  assert.ok(e2.length > 0, 'ゼロ幅入りの非ゼロ所見が通った');
});

test('必須セクションの見出しが HTML コメントのみ（`## <!-- 証拠表 -->`）は可視の見出しとみなさない（#406 Codex 指摘）', () => {
  // toString(heading) がコメント内テキストを含むと、GitHub 上で不可視の見出しでも
  // セクションが「見つかった」扱いになってしまう（偽陰性）
  const body = withEvidence('- [x] lint 実行 — npm run lint の出力: OK').replace(
    '## 証拠表',
    '## <!-- 証拠表 -->',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('証拠表') && e.includes('ありません')),
    `コメントのみの見出しが可視のセクションとして通った: ${JSON.stringify(errors)}`,
  );
});

test('証拠表: 無関係な別テーブルが後続すると列インデックスが引き継がれて誤ブロックしない（#406 Gemini 指摘）', () => {
  // declCol/evidenceCol/verdictCol がテーブルを跨いで共有されると、無関係な別テーブルの
  // ヘッダ行・データ行までもが証拠表の行として誤検査され「証拠がありません」を誤検出する
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | scripts/x.js:10 | ✅ |

| バージョン |  | メモ |
|---|---|---|
| v2 |  | 対応中 |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('証拠表: マークダウンリンク形式の証拠（[確認済み](tests/foo.test.js)）は URL が証拠ポインタとして機能する（#403）', () => {
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | [確認済み](tests/foo.test.js) | ✅ |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('証拠表: セル内のインラインコメントに隠した証拠ポインタは証拠として扱わない（#403）', () => {
  // GitHub 描画では空に見えるコメント内ポインタでのロンダリングを塞ぐ（旧 stripComments と同じ境界）
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | 確認済み <!-- tests/foo.test.js --> | ✅ |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('証拠がありません')),
    `コメント内ポインタが証拠として通った: ${JSON.stringify(errors)}`,
  );
});

test('証拠表: チェックリスト行のインラインコメントに隠した証拠ポインタも証拠として扱わない（#403）', () => {
  const body = withEvidence('- [x] 実行 — 確認済み <!-- tests/foo.test.js -->');
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('証拠がありません')),
    `チェックリストのコメント内ポインタが証拠として通った: ${JSON.stringify(errors)}`,
  );
});

test('証拠表: エスケープ済みバックスラッシュ＋パイプ（\\\\|）はセル区切りとして扱う（GFM 準拠）', () => {
  // 「tests\\| ✅」= リテラル \ ＋区切り。旧実装では \| をエスケープ扱いしてセルが結合し、
  // 判定列に ✅ が届かず検査がずれていた
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | 確認済み C:\\dir\\\\| ✅ |`);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('完了主張の行に証拠がありません')));
});

test('テーブル行: 行末スペースがあっても末尾セルの判定が崩れない', () => {
  const body = FULL_ARTIFACTS.replace(
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 | ',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('レビューループ記録: ループ表の後に別表を置いて収束を偽装しても通さない（#38）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |

| 詳細 | 補足 | 状態 |
|---|---|---|
| x | 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('収束宣言がありません')));
});

test('レビューループ記録: 空テンプレ表を残したまま下に完成表を貼っても有効な表で判定する（#42）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
|  |  |  |

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('レビューループ記録: 空テンプレ表＋下の完成表が未収束なら落ちる（#42 の裏）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
|  |  |  |

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('収束宣言がありません')));
});

test('レビューループ記録: 旧収束表を残して下に未収束表を貼っても最後の表で判定する（#44）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('収束宣言がありません')));
});

test('レビューループ記録: 複数表でも最後の表が収束していれば通る（#44 の裏）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('レビューループ記録: 「所見」のみで「対応」列がない不完全表は候補にせず後続の正表を使う（#45）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 新規所見 |
|---|---|
| 1 | 補足 |

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('レビューループ記録: 空行なしで標準表に連結した「0件｜収束」行でも迂回できない（#403 AST 境界）', () => {
  // GFM では空行なしの連結は1つのテーブル（GitHub 実描画と同じ解釈）。
  // 末尾の連結行はセル数が足りず対応列（4列目）に届かないため収束宣言として成立しない
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |
| 所見 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 対応 |
|---|---|
| 0件 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('収束')),
    `空行なし連結の詳細表で収束偽装が通った: ${JSON.stringify(errors)}`,
  );
});

test('レビューループ記録: リスト内にネストした未収束表も最後の候補として判定する（#44 の変種・#403）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |

- 追記:
  | 周回 | 系統 | 新規所見 | 対応 |
  |---|---|---|---|
  | 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('収束')),
    `リスト内の未収束表が無視され旧収束表で通った: ${JSON.stringify(errors)}`,
  );
});

test('レビューループ記録: 引用ブロック内の収束表は本人の宣言として扱わない（#403）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `> | 周回 | 系統 | 新規所見 | 対応 |
> |---|---|---|---|
> | 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('標準形式') || e.includes('収束')),
    `引用された収束表が本人の宣言として通った: ${JSON.stringify(errors)}`,
  );
});

test('レビューループ記録: 単一チルダの打ち消し線（~収束~）も宣言として通さない（#403 AST 境界）', () => {
  const body = FULL_ARTIFACTS.replace(
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |',
    '| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | ~収束~ |',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('収束宣言がありません')),
    `単一チルダの打ち消し線が収束宣言として通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 段落内インラインコメントの「関連issue: なし（理由）」例示は宣言として扱わない（#403 AST 境界）', () => {
  const body = FULL_ARTIFACTS.replace(
    'refs #1',
    '補足: <!-- 関連issue: なし（テンプレ例示） --> 本文続き',
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `インラインコメント内の例示が issue なし宣言として通った: ${JSON.stringify(errors)}`,
  );
});

test('レビューループ記録: 未収束の標準表の後ろに「所見｜対応」だけの詳細表を貼っても迂回できない（#46）', () => {
  const body = FULL_ARTIFACTS.replace(
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
    `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 3件 | 全修正 |

| 所見 | 対応 |
|---|---|
| 0件 | 収束 |`,
  );
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('収束')),
    `未収束の標準表が採用されず詳細表で迂回された: ${JSON.stringify(errors)}`,
  );
});

// --- タグ同居 html ノード内のコメント除去（#413） ---

test('関連 issue: タグ同居コメント内の参照（<!-- refs #1 --><b>x</b>）はゲートを通さない（#413）', () => {
  const body = buildBody({ issue: '<!-- refs #1 --><b>x</b>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `タグ同居コメント内の issue 参照がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: タグ先行のコメント同居（<b>x</b><!-- refs #1 -->）もゲートを通さない（#413）', () => {
  const body = buildBody({ issue: '<b>x</b><!-- refs #1 -->' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `タグ先行のコメント同居 issue 参照がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

// インライン位置の閉じ忘れ <!-- は mdast では text ノードで可視のため対象外（ブロックのみ検証）
test('関連 issue: 閉じ忘れブロックコメント内の参照（<!-- refs #1）はゲートを通さない（#413）', () => {
  const body = buildBody({ issue: '<!-- refs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  // 未クローズコメントは早期リターンで BLOCK される（#415）。参照が不可視で満たされないことに変わりはない
  assert.ok(
    errors.some((e) => e.includes('未クローズ') || e.includes('関連 issue')),
    `閉じ忘れコメント内の issue 参照がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 可視の refs #1 とタグ同居コメントの共存は過剰除去しない（#413）', () => {
  const body = buildBody({ issue: 'refs #1 <!-- note --><b>x</b>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: 属性値中の <!-- はコメント開始と誤認せず、後続の refs #1 は可視のまま扱う（#413 追加指摘: Codex）', () => {
  const body = buildBody({ issue: '<span title="<!-- note">説明</span>\n\nrefs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: 実タグと結合した閉じ忘れコメント（<div>x</div><!-- refs #1）はゲートを通さない（#413 追加指摘: 属性値誤認対策の回帰確認）', () => {
  const body = buildBody({ issue: '<div>x</div><!-- refs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('未クローズ') || e.includes('関連 issue')),
    `実タグ同居の閉じ忘れコメントがゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('sectionSourceLines: セクション内の閉じ忘れコメントの番兵 span が後続の兄弟ノードへ伝播する（#413 追加指摘: Gemini）', () => {
  const body = `## 完了条件
> <!-- unclosed comment bounded to this blockquote

本来ここは別ノードとして残るはずの可視テキスト。X を実装 — 検証方法: unit test

## 想定ケース
foo
`;
  const tree = parseBody(body);
  const { nodes } = findSection(tree, ['完了条件']);
  const lines = sectionSourceLines(body, nodes);
  assert.ok(
    !lines.some((l) => l.includes('本来ここは')),
    `閉じ忘れコメント後の兄弟ノードのテキストが伝播せず可視のまま残った: ${JSON.stringify(lines)}`,
  );
});

test('関連 issue: 属性値の引用符が閉じないまま文字列末尾に達しても quote 追跡が見逃さない（#413 追加指摘: 引用符バランス崩れのフェイルセーフ回帰）', () => {
  const body = buildBody({ issue: '<div title="unterminated<!-- refs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('未クローズ') || e.includes('関連 issue')),
    `閉じない引用符の後の閉じ忘れコメントがゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 正しく閉じた引用符内のアポストロフィ後の実タグ+閉じ忘れコメントはゲートを通さない（#413 追加指摘: quote 追跡の回帰確認）', () => {
  const body = buildBody({ issue: '<div alt="Bob\'s dog">x</div><!-- refs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('未クローズ') || e.includes('関連 issue')),
    `アポストロフィを含む属性値の後の閉じ忘れコメントがゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 後方の無関係な未閉鎖属性が、既に正しく閉じた別属性内の <!-- を誤って復活させない（#413 追加指摘: フォールバック範囲の限定回帰確認）', () => {
  const body = buildBody({
    issue: '<div title="note <!-- fake" onclick="unterminated>\n\nrefs #1',
  });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: matchAll が消費した閉じコメントの終端から quote 追跡を再開しない（#413 追加指摘: Codex 4周目）', () => {
  const body = buildBody({ issue: '<span title="a <!-- x --> b <!-- y">説明</span>\n\nrefs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: matchAll 消費境界が属性値の途中に来ても引用符パリティが崩れない（#413 追加指摘: Gemini 4周目）', () => {
  const body = buildBody({ issue: '<span title="<!-- note -->" data-x="<!--">refs #1</span>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: 閉じたコメント内の対応しない引用符が quote パリティに混入しない（#413 追加指摘: Codex 5周目）', () => {
  const body = buildBody({ issue: '<!-- " --><span title="<!-- fake">説明</span>\n\nrefs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: 属性値内の閉じたコメントで分断された偽の参照（title="re<!-- -->fs #1"）をゲートが通さない（#413 追加指摘: Codex 6周目・新規バイパス）', () => {
  const body = buildBody({ issue: '<span title="re<!-- -->fs #1">説明</span>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `属性値内の分断コメントが捏造した偽の refs #1 がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 要素テキスト内容の引用符が実コメントを覆い隠さない（<div>"<!-- refs #1 -->"</div>）（#413 追加指摘: タグ文脈追跡）', () => {
  const body = buildBody({ issue: '<div>"<!-- refs #1 -->"</div>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `要素テキスト内容の引用符に隠れた実コメント内の偽 refs #1 がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 空白/数字が続く < はタグ開始扱いせず後続の実コメントを取り逃さない（#413 追加指摘: tag-open-state）', () => {
  for (const issue of [
    '<div>\na < b <!-- refs #1 -->\n</div>',
    '<div>\n3 <4 <!-- refs #1 -->\n</div>',
  ]) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `リテラルの < に続く実コメント内の偽 refs #1 がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: マークアップ宣言/処理命令（<!DOCTYPE>・<?...>）の引用符を属性区切りと誤認しない（#413 追加指摘: 宣言状態）', () => {
  for (const issue of [
    '<!DOCTYPE "><!-- refs #1 -->"',
    '<!x "><!-- refs #1 -->"',
    '<?x "><!-- refs #1 -->"',
  ]) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `宣言/PI 内の引用符に隠れた後続コメントの偽 refs #1 がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

// --- GitHub 不可視の非コメント HTML マークアップ内に隠した参照はゲートを通さない（#417） ---

test('関連 issue: 属性値内に隠した refs はゲートを通さない（<a title="refs #1">）（#417）', () => {
  const body = buildBody({ issue: '<a title="refs #1">link</a>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `属性値内の隠し refs がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: DOCTYPE/PI/CDATA/script 本体に隠した refs はゲートを通さない（#417）', () => {
  for (const issue of [
    '<!DOCTYPE refs #1 html>',
    '<?x refs #1 ?>',
    '<![CDATA[ refs #1 ]]>',
    '<script>refs #1</script>',
  ]) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `不可視マークアップ内の隠し refs がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: インライン装飾をまたぐ可視参照は受理する（closes <b>#1</b>）（#417 過剰ブロック防止）', () => {
  const body = buildBody({ issue: 'closes <b>#1</b>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: テーブルセル境界をまたいで分断した参照は捏造扱いにしない（| refs | #1 |）（#417 追加指摘: Codex）', () => {
  const body = buildBody({ issue: '| refs | #1 |\n|---|---|\n| x | y |' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `セル境界で分断された偽の参照がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: リスト項目境界をまたいで分断した参照は捏造扱いにしない（- ref / - #1）（#417 追加指摘: Codex）', () => {
  const body = buildBody({ issue: '- ref\n- #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('関連 issue')),
    `項目境界で分断された偽の参照がゲートを通った: ${JSON.stringify(errors)}`,
  );
});

test('関連 issue: 単一セル/引用/リスト項目内の可視参照は受理する（#417 追加指摘: 過剰ブロック防止）', () => {
  for (const issue of ['| x |\n|---|\n| closes #1 |', '> closes #1', '- closes #1']) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.deepEqual(
      errors,
      [],
      `可視参照が誤ブロックされた: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: インライン境界要素（<br>/<img>/markdown 画像）をまたいだ分断参照は捏造扱いにしない（#418 追加指摘: Codex）', () => {
  for (const issue of ['re<br>fs #1', 're<img src=x>fs #1', 're<br/>fs #1', 're![x](u)fs #1']) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `インライン境界で分断された偽の参照がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: フロー系インライン装飾（<b>）は同一 run 内で連結を保持し可視参照を受理する（#418 追加指摘: 過剰ブロック防止）', () => {
  const body = buildBody({ issue: 'closes <b>#1</b>' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: フロー系以外のインライン HTML（<input>/<embed>/<svg>/未知タグ）は run 境界にし分断参照を捏造扱いにしない（#418 追加指摘: Codex・allowlist fail-safe）', () => {
  for (const issue of [
    're<input type="checkbox" disabled>fs #1',
    're<embed>fs #1',
    're<svg></svg>fs #1',
    're<foo>fs #1',
  ]) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `フロー系以外のインライン HTML 境界で分断された偽の参照がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: 不可視コメントをまたぐ連結は連続可視として受理する（re<!--x-->fs #1）（#418 追加指摘: 透過扱い）', () => {
  const body = buildBody({ issue: 're<!--x-->fs #1' });
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.deepEqual(errors, []);
});

test('関連 issue: 追加グリフ挿入/読み順変更のインライン HTML（<q>/<ruby>/<bdo>）は run 境界にする（#418 追加指摘: Codex）', () => {
  for (const issue of [
    're<q>fs #1</q>',
    're<ruby>fs #1<rt>x</rt></ruby>',
    're<bdo dir=rtl>fs #1</bdo>',
  ]) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.ok(
      errors.some((e) => e.includes('関連 issue')),
      `追加グリフ/並び替え要素で分断された偽の参照がゲートを通った: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

test('関連 issue: 純粋な視覚装飾のフロー系タグ（<del>/<mark>/<sub>）内の可視参照は受理する（#418 追加指摘: 過剰ブロック防止）', () => {
  for (const issue of ['closes <del>#1</del>', 'closes <mark>#1</mark>', 'closes <sub>#1</sub>']) {
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: buildBody({ issue }) });
    assert.deepEqual(
      errors,
      [],
      `純粋装飾内の可視参照が誤ブロックされた: ${JSON.stringify({ issue, errors })}`,
    );
  }
});

// --- 未クローズ HTML コメントによる構造ゲート回避（#415） ---

test('未クローズ HTML コメントがリスト内でテーブルを飲み込み証拠表チェックを回避する→未クローズを検出（#415）', () => {
  const body = `## 完了条件
- [x] X — 検証: test

## 想定ケース
- 異常系

## 既存実装調査
- Grep 'x' src/ → なし（新規）

## 証拠表
まだ後述。
- <!-- unclosed comment starts here
  | 宣言 | 証拠 | 判定 |
  |---|---|---|
  | Y を実装 |  | ✅ |

## レビューループ記録
| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |

refs #1
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    errors.some((e) => e.includes('未クローズ')),
    `未クローズコメントによる飲み込みが検出されなかった: ${JSON.stringify(errors)}`,
  );
});

test('未クローズ HTML コメントは早期リターンし必須セクション欠落の二次エラーを出さない（#415）', () => {
  // 未クローズコメントが以降（必須セクション群）を飲み込むケース。二次的な
  // 「必須セクションがありません」カスケードを出さず、未クローズエラーのみ提示する
  const body = `## 完了条件
- [x] X — 検証: test

- <!-- unclosed swallows the rest
## 想定ケース
- 異常系
`;
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(errors.some((e) => e.includes('未クローズ')));
  assert.ok(
    !errors.some((e) => e.includes('必須セクション')),
    `未クローズ検出時に必須セクション欠落の二次エラーが出た: ${JSON.stringify(errors)}`,
  );
});

test('未クローズ HTML コメント: コードフェンス内の <!-- は検出しない（可視のため。#415）', () => {
  const body = withEvidence(`| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | src/x.js:1 / tests/x.test.js | ✅ |

\`\`\`html
<!-- 未クローズだがフェンス内なので可視・無害
\`\`\``);
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    !errors.some((e) => e.includes('未クローズ')),
    `フェンス内の <!-- を誤検出した: ${JSON.stringify(errors)}`,
  );
});

test('未クローズ HTML コメント: 閉じたテンプレコメントは誤検出しない（#415）', () => {
  const body = FULL_ARTIFACTS.replace('refs #1', '<!-- 補足: 閉じたコメント --> refs #1');
  const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body });
  assert.ok(
    !errors.some((e) => e.includes('未クローズ')),
    `閉じたコメントを未クローズと誤検出した: ${JSON.stringify(errors)}`,
  );
});

test('未クローズ HTML コメント: 依存 manifest のみ（artifact 非必須）では検出しない（#415）', () => {
  // Phase 2 で docs のみの変更は Docs mandate になり非必須ではなくなったため、真に
  // 非必須な depOnly（依存 manifest のみ）で「非必須なら検出しない」の意図を検証する
  const body = '## 変更の概要\n- <!-- unclosed\n  本文';
  const { errors, mandated } = checkArtifacts({
    changedFiles: ['package.json', 'package-lock.json'],
    body,
  });
  assert.equal(mandated, false);
  assert.ok(!errors.some((e) => e.includes('未クローズ')));
});

test('Phase2: 未クローズ HTML コメント: docs のみ（Docs mandate）では検出する（#415 の Phase2 拡張）', () => {
  const body = '## 変更の概要\n- <!-- unclosed\n  本文';
  const { errors, mandated } = checkArtifacts({ changedFiles: ['docs/x.md'], body });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('未クローズ')));
});

// --- 設計文書 mandate（#452: 実行可能設計文書のみの PR はレビューループ記録＋Tier 宣言を必須化） ---

const DESIGN_FILES = ['docs/agent-workflows/review-angles/angle-spec.md'];
const designLoopBody = (loopSection) =>
  `## 変更の概要\n設計文書の更新\n\n## レビューループ記録\n${loopSection}\n`;
const DESIGN_OK_LOOP = `Tier: 設計文書（レビュー手順の正本変更）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋仕様＋運用性＋清掃 | 2件 | 全修正 |
| 2 | 減算＋仕様＋運用性＋清掃 | 0件 | 収束 |`;

test('設計文書のみの PR: レビューループ記録セクションがない → エラー（#452）', () => {
  const { errors, mandated } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: '## 変更の概要\n設計文書の更新',
  });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('レビューループ記録') && e.includes('必須')));
});

test('設計文書のみの PR: Tier 宣言＋仕様・運用性の実施記録＋収束で受理。他セクションは要求しない（#452）', () => {
  const { errors, mandated } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: designLoopBody(DESIGN_OK_LOOP),
  });
  assert.equal(mandated, true);
  assert.deepEqual(errors, []);
});

test('設計文書のみの PR: Tier 宣言が「Light」→ エラー（宣言名は設計文書）（#452）', () => {
  const { errors } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: designLoopBody(
      DESIGN_OK_LOOP.replace('Tier: 設計文書（レビュー手順の正本変更）', 'Tier: Light（誤宣言）'),
    ),
  });
  assert.ok(errors.some((e) => e.includes('設計文書')));
});

test('設計文書のみの PR: 仕様の実施行が欠落 → エラー（#452）', () => {
  const { errors } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: designLoopBody(`Tier: 設計文書（正本変更）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 運用性 | 0件 | 収束 |`),
  });
  assert.ok(errors.some((e) => e.includes('必須の系統') && e.includes('仕様')));
});

test('設計文書のみの PR: 免除宣言（Tier: なし（説明・記録文書: 理由））はループ表なしで受理し警告を出す（#452）', () => {
  const { errors, warnings } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: designLoopBody('Tier: なし（説明・記録文書: 誤字修正のみ）'),
  });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('免除')));
});

test('設計文書のみの PR: 免除理由の書式外（説明・記録文書: 接頭辞なし）→ エラー（#452）', () => {
  const { errors } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: designLoopBody('Tier: なし（誤字修正のみ）'),
  });
  assert.ok(errors.some((e) => e.includes('説明・記録文書')));
});

test('設計文書のみの PR: 未クローズ HTML コメントは fail-loud（セクション飲み込み偽装を塞ぐ）（#452）', () => {
  const { errors } = checkArtifacts({
    changedFiles: DESIGN_FILES,
    body: '## 変更の概要\n<!-- unclosed\n' + designLoopBody(DESIGN_OK_LOOP),
  });
  assert.ok(errors.some((e) => e.includes('未クローズ')));
});

// --- CLI: GitHub Actions annotation のワークフローコマンド注入対策（#452 3周目 A-r3-2） ---

test('CLI: GITHUB_ACTIONS 下で警告に改行由来のワークフローコマンドを注入できない', () => {
  // skip マーカーは [^>]* で改行をまたぐ。理由に改行＋ワークフローコマンドを埋めても
  // 独立行の ::error:: にならないこと。埋め込み改行は escapeWorkflowData の %0A エスケープ
  // に渡す前に空白へ潰す（証明行の敵対的レビュー ADV-1: GitHub Actions の annotation は
  // 表示時に %0A を改行として復元し、タイムスタンプの付かない単独行を作れてしまうため、
  // %0A エスケープに頼らず埋め込み改行そのものを発生させない — check-artifacts.js の
  // sanitizeForLogLine 参照）。
  const body = '実装\n<!-- artifacts-check: skip (理由\n::error::INJECTED\n) -->';
  const { stderr, status } = spawnSync('node', [CHECK_ARTIFACTS_SCRIPT, '--body', body], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', CHANGED_FILES: 'src/a.js' },
  });
  assert.equal(status, 0); // skip は通過
  // 注入行が独立の ::error:: として出ていないこと
  assert.ok(
    !/^::error::INJECTED$/m.test(stderr),
    `ワークフローコマンドが注入された: ${JSON.stringify(stderr)}`,
  );
  // 埋め込み改行そのものが除去されているため %0A エスケープの余地が無い
  assert.ok(!stderr.includes('%0A'), `改行が残っている: ${JSON.stringify(stderr)}`);
  assert.ok(stderr.includes('::error::INJECTED'), `理由の内容自体は残る想定: ${JSON.stringify(stderr)}`);
});


// --- CLI: 0件差分の警告に base を出すのは git フォールバック経路のみ（#446 round4 観点別レビュー 運用性N3） ---

test('CLI: CHANGED_FILES env 経由の 0 件は警告に base を含めない', () => {
  const { stderr, status } = spawnSync('node', [CHECK_ARTIFACTS_SCRIPT], {
    encoding: 'utf-8',
    // 空白1個は非空文字列（env 経由と判定される）だが split 後は 0 件になる
    env: { PATH: process.env.PATH, CHANGED_FILES: ' ' },
  });
  assert.equal(status, 0);
  assert.match(stderr, /変更ファイルが 0 件でした。/);
  assert.doesNotMatch(stderr, /base=/);
});

test('CLI: CHANGED_FILES 未設定で git フォールバックした 0 件は警告に base を含める', (t) => {
  const dir = makeTmpGitRepo('check-artifacts-zerofiles-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['commit', '--allow-empty', '-qm', 'base']);
  const { stderr, status } = spawnSync('node', [CHECK_ARTIFACTS_SCRIPT], {
    encoding: 'utf-8',
    cwd: dir,
    env: { PATH: process.env.PATH, BASE_REF: 'HEAD' },
  });
  assert.equal(status, 0);
  assert.match(stderr, /変更ファイルが 0 件でした（base=HEAD）。/);
});
